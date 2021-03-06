const _ = require("lodash");
const { getAWSSDK } = require("../lib/aws");
const { getQueueUrl } = require("../lib/sqs");
const { getTopicArn } = require("../lib/sns");
const { Command, flags } = require("@oclif/command");
const { checkVersion } = require("../lib/version-check");
const { track } = require("../lib/analytics");

class ReplaySqsDlqCommand extends Command {
	async run() {
		const { flags } = this.parse(ReplaySqsDlqCommand);
		const {
			dlqQueueName,
			targetName,
			targetType,
			targetRegion,
			targetProfile,
			region,
			concurrency,
			profile,
			keep
		} = flags;

		global.region = region;
		global.profile = profile;
		global.keep = keep;
		const AWS = getAWSSDK();
		global.SQS = new AWS.SQS();

		const targetOptions = {
			region: targetRegion,
			profile: targetProfile
		};

		checkVersion();

		track("replay-sqs-dlq", { region, targetType, concurrency, keep });

		this.log(`finding the SQS DLQ [${dlqQueueName}] in [${region}]`);
		const dlqQueueUrl = await getQueueUrl(dlqQueueName);

		let sendToTarget;
		switch (targetType) {
			case "SNS":
				this.log(
					`finding the SNS topic [${targetName}] in [${targetRegion || region}]`
				);
				sendToTarget = this.sendToSNS(
					await getTopicArn(targetName, targetOptions),
					targetOptions
				);
				break;
			case "Kinesis":
				sendToTarget = this.sendToKinesis(targetName, targetOptions);
				break;
			default:
				this.log(
					`finding the SQS queue [${targetName}] in [${targetRegion || region}]`
				);
				sendToTarget = this.sendToSQS(
					await getQueueUrl(targetName, targetOptions),
					targetOptions
				);
				break;
		}

		this.log(
			`replaying events from [${dlqQueueUrl}] to [${targetType}:${targetName}] with ${concurrency} concurrent pollers`
		);
		await this.replay(dlqQueueUrl, concurrency, sendToTarget);

		this.log("all done!");
	}

	async replay(dlqQueueUrl, concurrency, sendToTarget) {
		const promises = _.range(0, concurrency).map(() =>
			this.runPoller(dlqQueueUrl, sendToTarget)
		);
		await Promise.all(promises);
	}

	sendToSQS(queueUrl, options) {
		const AWS = getAWSSDK(options);
		const SQS = new AWS.SQS();

		return async messages => {
			const sendEntries = messages.map(msg => ({
				Id: msg.MessageId,
				MessageBody: msg.Body,
				MessageAttributes: msg.MessageAttributes
			}));
			await SQS.sendMessageBatch({
				QueueUrl: queueUrl,
				Entries: sendEntries
			}).promise();
		};
	}

	sendToSNS(topicArn, options) {
		const AWS = getAWSSDK(options);
		const SNS = new AWS.SNS();

		return async messages => {
			const promises = messages.map(async msg => {
				const msgAttrPairs = _.toPairs(msg.MessageAttributes);
				const supportedAttrs = msgAttrPairs
					// eslint-disable-next-line no-unused-vars
					.filter(([key, value]) => value.DataType === "String")
					.map(([key, { DataType, StringValue }]) => [
						key,
						{ DataType, StringValue }
					]);
				const messageAttributes = _.fromPairs(supportedAttrs);
				await SNS.publish({
					Message: msg.Body,
					MessageAttributes: messageAttributes,
					TopicArn: topicArn
				}).promise();
			});

			await Promise.all(promises);
		};
	}

	sendToKinesis(streamName, options) {
		const AWS = getAWSSDK(options);
		const Kinesis = new AWS.Kinesis();

		return async messages => {
			const records = messages.map(msg => ({
				Data: msg.Body,
				PartitionKey: msg.MessageId
			}));
			await Kinesis.putRecords({
				StreamName: streamName,
				Records: records
			}).promise();
		};
	}

	async runPoller(dlqQueueUrl, sendToTarget) {
		let emptyReceives = 0;
		let seenMessageIds = new Set();

		// eslint-disable-next-line no-constant-condition
		while (true) {
			const resp = await global.SQS.receiveMessage({
				QueueUrl: dlqQueueUrl,
				MaxNumberOfMessages: 10,
				MessageAttributeNames: ["All"]
			}).promise();

			if (_.isEmpty(resp.Messages)) {
				emptyReceives += 1;

				// if we don't receive anything 10 times in a row, assume the queue is empty
				if (emptyReceives >= 10) {
					break;
				} else {
					continue;
				}
			}

			emptyReceives = 0;
			await sendToTarget(resp.Messages);

			if (global.keep) {
				resp.Messages.forEach(msg => seenMessageIds.add(msg.MessageId));
			} else {
				const deleteEntries = resp.Messages.map(msg => ({
					Id: msg.MessageId,
					ReceiptHandle: msg.ReceiptHandle
				}));
				await global.SQS.deleteMessageBatch({
					QueueUrl: dlqQueueUrl,
					Entries: deleteEntries
				}).promise();
			}
		}
	}
}

ReplaySqsDlqCommand.description =
	"Replays the messages in a SQS DLQ back to the main queue";
ReplaySqsDlqCommand.flags = {
	dlqQueueName: flags.string({
		char: "d",
		description: "name of the SQS DLQ queue, e.g. task-queue-dlq-dev",
		required: true
	}),
	targetName: flags.string({
		char: "n",
		description: "name of the target SQS queue/SNS topic, e.g. task-queue-dev",
		required: true
	}),
	targetType: flags.string({
		char: "t",
		description: "valid values are SQS [default], SNS, and Kinesis",
		required: false,
		options: ["SQS", "SNS", "Kinesis"],
		default: "SQS"
	}),
	targetProfile: flags.string({
		description: "AWS CLI profile name to use for the target account",
		required: false
	}),
	targetRegion: flags.string({
		description: "AWS region for the target resource, e.g. eu-west-1",
		required: false
	}),
	region: flags.string({
		char: "r",
		description: "AWS region, e.g. us-east-1",
		required: true
	}),
	concurrency: flags.integer({
		char: "c",
		description: "how many concurrent pollers to run",
		required: false,
		default: 10
	}),
	profile: flags.string({
		char: "p",
		description: "AWS CLI profile name",
		required: false
	}),
	keep: flags.boolean({
		char: "k",
		description: "whether to keep the replayed messages in the DLQ",
		required: false,
		default: false
	})
};

module.exports = ReplaySqsDlqCommand;
