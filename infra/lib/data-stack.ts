import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as sns from 'aws-cdk-lib/aws-sns';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as path from 'node:path';
import * as fs from 'node:fs';

export class DataStack extends cdk.Stack {
  readonly flows: ddb.Table; readonly meta: ddb.Table; readonly collector: lambda.Function;
  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);
    this.flows = new ddb.Table(this, 'Flows', {
      tableName: 'nfm-dashboard-flows',
      partitionKey: { name: 'pk', type: ddb.AttributeType.STRING },
      sortKey: { name: 'sk', type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      stream: ddb.StreamViewType.NEW_IMAGE,
      timeToLiveAttribute: 'ttl', removalPolicy: cdk.RemovalPolicy.DESTROY });
    for (const [i, [pk, sk]] of ([['gsi1pk','gsi1sk'],['gsi2pk','gsi2sk'],['gsi3pk','gsi3sk']] as const).entries())
      this.flows.addGlobalSecondaryIndex({ indexName: `GSI${i+1}`,
        partitionKey: { name: pk, type: ddb.AttributeType.STRING },
        sortKey: { name: sk, type: ddb.AttributeType.STRING } });
    this.meta = new ddb.Table(this, 'Meta', {
      tableName: 'nfm-dashboard-meta',
      partitionKey: { name: 'pk', type: ddb.AttributeType.STRING },
      sortKey: { name: 'sk', type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl', removalPolicy: cdk.RemovalPolicy.DESTROY });

    // Real-time flow-level alerting: the collector evaluates reliability
    // breaches every cycle (current-window only) and pushes state
    // TRANSITIONS (ALARM/OK) here — distinct from the infra-health
    // `nfm-dashboard-alarms` topic in OpsAlarmsStack. A dedicated topic so a
    // same-account subscriber (e.g. a server-to-server consumer's SQS queue)
    // can filter on this stream alone without also matching ALB/collector
    // infra alarms.
    const flowAlertTopic = new sns.Topic(this, 'FlowAlertTopic', {
      topicName: 'nfm-dashboard-flow-alerts',
      displayName: 'nfm-dashboard flow-level alerts (reliability breaches)',
    });

    const collectorDist = path.join(__dirname, '../../collector/dist');
    if (!fs.existsSync(path.join(collectorDist, 'handler.mjs')))
      throw new Error('collector/dist/handler.mjs missing — run: npm -w collector run build');
    this.collector = new lambda.Function(this, 'Collector', {
      functionName: 'nfm-dashboard-collector',
      runtime: lambda.Runtime.NODEJS_22_X, architecture: lambda.Architecture.ARM_64,
      handler: 'handler.handler', memorySize: 512, timeout: cdk.Duration.seconds(270),
      code: lambda.Code.fromAsset(collectorDist),
      environment: { TABLE_FLOWS: this.flows.tableName, TABLE_META: this.meta.tableName,
        MONITORS: this.node.tryGetContext('nfmMonitors') ?? '', CONCURRENCY: '5',
        EXTENDED_CATEGORY_EVERY: '3', DNS_COLLECT_EVERY: '3',
        DNS_CORE_GROUPS: ['fsi-demo-cluster', 'mall-apne2-az-a', 'mall-apne2-az-c',
          'mall-apne2-mgmt'].map(c => `/aws/containerinsights/${c}/application`).join(','),
        DNS_RESOLVER_GROUP: '/nfm-dashboard/resolver-dns',
        FLOW_ALERT_TOPIC_ARN: flowAlertTopic.topicArn } });
    // Read + write: the hour-close rollup step Queries FLOW# partitions back
    // out of the flows table to merge them into HFLOW rows (ADR-009); the
    // ALERTSTATE#reliability item is a plain Get/Put on the same table.
    this.flows.grantReadWriteData(this.collector);
    this.meta.grantReadWriteData(this.collector);
    flowAlertTopic.grantPublish(this.collector);
    this.collector.addToRolePolicy(new iam.PolicyStatement({ actions: [
      'networkflowmonitor:StartQueryMonitorTopContributors',
      'networkflowmonitor:GetQueryStatusMonitorTopContributors',
      'networkflowmonitor:GetQueryResultsMonitorTopContributors',
      'networkflowmonitor:StopQueryMonitorTopContributors',
      'networkflowmonitor:ListMonitors',
      'networkflowmonitor:ListScopes',
      'networkflowmonitor:StartQueryWorkloadInsightsTopContributors',
      'networkflowmonitor:GetQueryStatusWorkloadInsightsTopContributors',
      'networkflowmonitor:GetQueryResultsWorkloadInsightsTopContributors',
      'networkflowmonitor:StopQueryWorkloadInsightsTopContributors',
      'ec2:DescribeInstances', 'ec2:CreateTags'], resources: ['*'] }));
    this.collector.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:ListAttachedRolePolicies', 'iam:GetInstanceProfile'],
      resources: [`arn:aws:iam::${this.account}:role/*`, `arn:aws:iam::${this.account}:instance-profile/*`] }));
    this.collector.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:AttachRolePolicy'], resources: [`arn:aws:iam::${this.account}:role/*`],
      conditions: { ArnEquals: { 'iam:PolicyARN':
        'arn:aws:iam::aws:policy/CloudWatchNetworkFlowMonitorAgentPublishPolicy' } } }));
    // DNS pass: Logs Insights over CoreDNS (Container Insights) + Resolver query log groups.
    // StartQuery supports log-group scoping; GetQueryResults/StopQuery take only a queryId
    // (no resource type in the CWL service authorization reference), so they need '*'.
    this.collector.addToRolePolicy(new iam.PolicyStatement({ actions: ['logs:StartQuery'],
      resources: [
        `arn:aws:logs:ap-northeast-2:${this.account}:log-group:/aws/containerinsights/*`,
        `arn:aws:logs:ap-northeast-2:${this.account}:log-group:/nfm-dashboard/resolver-dns`,
        `arn:aws:logs:ap-northeast-2:${this.account}:log-group:/nfm-dashboard/resolver-dns:*`] }));
    this.collector.addToRolePolicy(new iam.PolicyStatement({
      actions: ['logs:GetQueryResults', 'logs:StopQuery'], resources: ['*'] }));

    const schedRole = new iam.Role(this, 'SchedRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com') });
    this.collector.grantInvoke(schedRole);
    new scheduler.CfnSchedule(this, 'Every5m', {
      flexibleTimeWindow: { mode: 'OFF' }, scheduleExpression: 'rate(5 minutes)',
      target: { arn: this.collector.functionArn, roleArn: schedRole.roleArn } });

    // ─── Phase 13 (②): flow archive pipeline ──────────────────────────────────
    // DynamoDB Streams (NEW_IMAGE on flows) → transform Lambda → Firehose (Parquet
    // conversion via the Glue schema) → S3, catalogued in Glue + queryable via Athena.
    // Fixed resource names so app-stack can reference them by name/ARN (no cross-stack export).
    const region = this.region;
    const account = this.account;
    const ARCHIVE_BUCKET = `nfm-dashboard-flow-archive-${account}`;
    const RESULTS_BUCKET = `nfm-dashboard-athena-results-${account}`;
    const GLUE_DB = 'nfm_dashboard';
    const GLUE_TABLE = 'flows_archive';
    const ATHENA_WG = 'nfm-dashboard';
    const FIREHOSE_STREAM = 'nfm-dashboard-flow-archive';

    // S3: archive bucket = the durable copy (RETAIN), Athena results bucket = disposable (DESTROY + 30d expiry).
    const archiveBucket = new s3.Bucket(this, 'FlowArchiveBucket', {
      bucketName: ARCHIVE_BUCKET,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN });
    new s3.Bucket(this, 'AthenaResultsBucket', {
      bucketName: RESULTS_BUCKET,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(30) }] });

    // Glue catalog: database + external Parquet table with partition projection on `dt`.
    // COLUMNS MUST MATCH the transform Lambda's FlatFlowRow EXACTLY (minus `dt`, the partition key).
    // A name/type divergence silently routes every Firehose record to the errors/ prefix.
    const glueDb = new glue.CfnDatabase(this, 'ArchiveGlueDb', {
      catalogId: account,
      databaseInput: { name: GLUE_DB, description: 'NFM dashboard flow archive catalog' } });
    const archiveColumns: glue.CfnTable.ColumnProperty[] = [
      { name: 'edge_hash', type: 'string' },
      { name: 'monitor', type: 'string' },
      { name: 'metric', type: 'string' },
      { name: 'category', type: 'string' },
      { name: 'bucket', type: 'string' },
      { name: 'value', type: 'double' },
      { name: 'unit', type: 'string' },
      { name: 'a_ip', type: 'string' },
      { name: 'a_instance_id', type: 'string' },
      { name: 'a_subnet_id', type: 'string' },
      { name: 'a_az', type: 'string' },
      { name: 'a_vpc_id', type: 'string' },
      { name: 'a_region', type: 'string' },
      { name: 'a_pod_name', type: 'string' },
      { name: 'a_pod_namespace', type: 'string' },
      { name: 'a_service_name', type: 'string' },
      { name: 'b_ip', type: 'string' },
      { name: 'b_instance_id', type: 'string' },
      { name: 'b_subnet_id', type: 'string' },
      { name: 'b_az', type: 'string' },
      { name: 'b_vpc_id', type: 'string' },
      { name: 'b_region', type: 'string' },
      { name: 'b_pod_name', type: 'string' },
      { name: 'b_pod_namespace', type: 'string' },
      { name: 'b_service_name', type: 'string' },
      { name: 'snat_ip', type: 'string' },
      { name: 'dnat_ip', type: 'string' },
      { name: 'target_port', type: 'int' },
      { name: 'traversed_constructs', type: 'string' },
    ];
    const glueTable = new glue.CfnTable(this, 'ArchiveGlueTable', {
      catalogId: account,
      databaseName: GLUE_DB,
      tableInput: {
        name: GLUE_TABLE,
        tableType: 'EXTERNAL_TABLE',
        partitionKeys: [{ name: 'dt', type: 'string' }],
        parameters: {
          classification: 'parquet',
          'projection.enabled': 'true',
          'projection.dt.type': 'date',
          'projection.dt.format': 'yyyy-MM-dd',
          'projection.dt.range': '2026-07-01,NOW',
          'projection.dt.interval': '1',
          'projection.dt.interval.unit': 'DAYS',
          'storage.location.template': `s3://${ARCHIVE_BUCKET}/flows/dt=\${dt}/`,
        },
        storageDescriptor: {
          columns: archiveColumns,
          location: `s3://${ARCHIVE_BUCKET}/flows/`,
          inputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
          serdeInfo: {
            serializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe',
          },
        },
      },
    });
    glueTable.addDependency(glueDb);

    // Athena workgroup: results to the results bucket, enforce config, 2 GB per-query scan cap.
    new athena.CfnWorkGroup(this, 'ArchiveWorkGroup', {
      name: ATHENA_WG,
      recursiveDeleteOption: true,
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        bytesScannedCutoffPerQuery: 2147483648,
        resultConfiguration: { outputLocation: `s3://${RESULTS_BUCKET}/athena/` },
      },
    });

    // Firehose delivery role: read/write the archive bucket + read the Glue schema + logs.
    const firehoseRole = new iam.Role(this, 'FlowArchiveFirehoseRole', {
      assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com') });
    archiveBucket.grantReadWrite(firehoseRole);
    firehoseRole.addToPolicy(new iam.PolicyStatement({
      actions: ['glue:GetTable', 'glue:GetTableVersion', 'glue:GetTableVersions'],
      resources: [
        `arn:aws:glue:${region}:${account}:catalog`,
        `arn:aws:glue:${region}:${account}:database/${GLUE_DB}`,
        `arn:aws:glue:${region}:${account}:table/${GLUE_DB}/${GLUE_TABLE}`,
      ] }));
    firehoseRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [`arn:aws:logs:${region}:${account}:log-group:/aws/kinesisfirehose/*`] }));

    // Firehose L1 (Parquet conversion is only available on CfnDeliveryStream, not the L2).
    const deliveryStream = new firehose.CfnDeliveryStream(this, 'FlowArchiveStream', {
      deliveryStreamName: FIREHOSE_STREAM,
      deliveryStreamType: 'DirectPut',
      extendedS3DestinationConfiguration: {
        bucketArn: archiveBucket.bucketArn,
        roleArn: firehoseRole.roleArn,
        prefix: 'flows/dt=!{partitionKeyFromQuery:dt}/',
        errorOutputPrefix: 'errors/!{firehose:error-output-type}/',
        bufferingHints: { sizeInMBs: 128, intervalInSeconds: 300 },
        compressionFormat: 'UNCOMPRESSED', // Parquet handles its own compression.
        dynamicPartitioningConfiguration: { enabled: true },
        cloudWatchLoggingOptions: { enabled: true,
          logGroupName: '/aws/kinesisfirehose/nfm-dashboard-flow-archive', logStreamName: 'S3Delivery' },
        processingConfiguration: {
          enabled: true,
          processors: [{
            type: 'MetadataExtraction',
            parameters: [
              { parameterName: 'MetadataExtractionQuery', parameterValue: '{dt:.dt}' },
              { parameterName: 'JsonParsingEngine', parameterValue: 'JQ-1.6' },
            ],
          }],
        },
        dataFormatConversionConfiguration: {
          enabled: true,
          inputFormatConfiguration: { deserializer: { openXJsonSerDe: {} } },
          outputFormatConfiguration: { serializer: { parquetSerDe: {} } },
          schemaConfiguration: {
            roleArn: firehoseRole.roleArn,
            databaseName: GLUE_DB,
            tableName: GLUE_TABLE,
            region,
            versionId: 'LATEST',
          },
        },
      },
    });
    // Glue table must exist before Firehose resolves the schema; role before the stream refs it.
    deliveryStream.addDependency(glueTable);
    deliveryStream.node.addDependency(firehoseRole);

    // Transform Lambda: DynamoDB Streams (NEW_IMAGE) → flat JSON → Firehose PutRecordBatch.
    // Mirrors the collector construct (prebuilt esbuild asset in collector/dist).
    if (!fs.existsSync(path.join(collectorDist, 'archive-transform.mjs')))
      throw new Error('collector/dist/archive-transform.mjs missing — run: npm -w collector run build');
    const archiveTransform = new lambda.Function(this, 'ArchiveTransform', {
      functionName: 'nfm-dashboard-archive-transform',
      runtime: lambda.Runtime.NODEJS_22_X, architecture: lambda.Architecture.ARM_64,
      handler: 'archive-transform.handler', memorySize: 256, timeout: cdk.Duration.seconds(60),
      code: lambda.Code.fromAsset(collectorDist),
      environment: { FIREHOSE_STREAM } }); // AWS_REGION is provided by the Lambda runtime.
    this.flows.grantStreamRead(archiveTransform);
    archiveTransform.addEventSource(new DynamoEventSource(this.flows, {
      startingPosition: lambda.StartingPosition.TRIM_HORIZON,
      batchSize: 100, retryAttempts: 3, bisectBatchOnError: true, reportBatchItemFailures: false }));
    archiveTransform.addToRolePolicy(new iam.PolicyStatement({
      actions: ['firehose:PutRecordBatch', 'firehose:PutRecord'],
      resources: [deliveryStream.attrArn] }));

    new cdk.CfnOutput(this, 'FlowArchiveStreamName', { value: FIREHOSE_STREAM });
    new cdk.CfnOutput(this, 'FlowArchiveBucketName', { value: archiveBucket.bucketName });
    new cdk.CfnOutput(this, 'FlowAlertTopicArn', { value: flowAlertTopic.topicArn }); // subscribe an SQS queue here for real-time reliability-breach push
  }
}
