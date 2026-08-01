import { it, expect } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DataStack } from '../lib/data-stack';

it('DataStack has 2 tables with TTL+GSIs, collector fn, 5min schedule', () => {
  const t = Template.fromStack(new DataStack(new App(), 'T',
    { env: { account: '123456789012', region: 'ap-northeast-2' } }));
  t.hasResourceProperties('AWS::DynamoDB::Table', {
    TableName: 'nfm-dashboard-flows',
    TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true } });
  t.hasResourceProperties('AWS::DynamoDB::Table', { TableName: 'nfm-dashboard-meta' });
  t.hasResourceProperties('AWS::Lambda::Function', {
    FunctionName: 'nfm-dashboard-collector', Architectures: ['arm64'], Timeout: 270 });
  t.hasResourceProperties('AWS::Scheduler::Schedule', {
    ScheduleExpression: 'rate(5 minutes)' });
});

it('collector can READ the flows table (hour-close rollup queries raw buckets back)', () => {
  const t = Template.fromStack(new DataStack(new App(), 'T',
    { env: { account: '123456789012', region: 'ap-northeast-2' } }));
  // The rollup step (collector/src/rollup-store.ts) Queries FLOW# partitions to
  // merge closed hours — write-only flows access breaks it with AccessDenied
  // (observed live on the 2026-07-15 first deploy). The meta table's read grant
  // lives in the same merged DefaultPolicy, so this must assert Query against
  // the FLOWS table resource specifically.
  const flowsLogicalId = Object.entries(t.findResources('AWS::DynamoDB::Table'))
    .find(([, r]) => r.Properties.TableName === 'nfm-dashboard-flows')![0];
  const policies = Object.values(t.findResources('AWS::IAM::Policy'))
    .filter((p) => JSON.stringify(p.Properties.Roles).includes('Collector'));
  const statements = policies.flatMap((p) => p.Properties.PolicyDocument.Statement as
    { Action: string | string[]; Resource: unknown }[]);
  const flowsQueryAllowed = statements.some((s) =>
    ([] as string[]).concat(s.Action).includes('dynamodb:Query')
    && JSON.stringify(s.Resource).includes(flowsLogicalId));
  expect(flowsQueryAllowed).toBe(true);
});

it('DataStack has a dedicated flow-alert SNS topic the collector can publish to', () => {
  const t = Template.fromStack(new DataStack(new App(), 'T',
    { env: { account: '123456789012', region: 'ap-northeast-2' } }));
  t.hasResourceProperties('AWS::SNS::Topic', { TopicName: 'nfm-dashboard-flow-alerts' });
  t.hasResourceProperties('AWS::Lambda::Function', {
    FunctionName: 'nfm-dashboard-collector',
    Environment: { Variables: Match.objectLike({ FLOW_ALERT_TOPIC_ARN: Match.anyValue() }) } });
  const topicLogicalId = Object.keys(t.findResources('AWS::SNS::Topic'))[0];
  const policies = Object.values(t.findResources('AWS::IAM::Policy'))
    .filter((p) => JSON.stringify(p.Properties.Roles).includes('Collector'));
  const statements = policies.flatMap((p) => p.Properties.PolicyDocument.Statement as
    { Action: string | string[]; Resource: unknown }[]);
  const publishAllowed = statements.some((s) =>
    ([] as string[]).concat(s.Action).includes('sns:Publish')
    && JSON.stringify(s.Resource).includes(topicLogicalId));
  expect(publishAllowed).toBe(true);
});

it('DataStack collector has DNS env + Logs Insights IAM', () => {
  const t = Template.fromStack(new DataStack(new App(), 'T',
    { env: { account: '123456789012', region: 'ap-northeast-2' } }));
  t.hasResourceProperties('AWS::Lambda::Function', {
    FunctionName: 'nfm-dashboard-collector',
    Environment: { Variables: Match.objectLike({
      DNS_COLLECT_EVERY: '3', EXTENDED_CATEGORY_EVERY: '3',
      DNS_RESOLVER_GROUP: '/nfm-dashboard/resolver-dns',
      DNS_CORE_GROUPS: Match.stringLikeRegexp(
        'containerinsights/fsi-demo-cluster/application.*mall-apne2-mgmt/application') }) } });
  t.hasResourceProperties('AWS::IAM::Policy', { PolicyDocument: { Statement: Match.arrayWith([
    Match.objectLike({ Action: 'logs:StartQuery', Resource: Match.arrayWith([
      'arn:aws:logs:ap-northeast-2:123456789012:log-group:/aws/containerinsights/*']) }),
    Match.objectLike({ Action: ['logs:GetQueryResults', 'logs:StopQuery'], Resource: '*' }),
  ]) } });
});
