import { BusinessError } from './errors.ts';
import { toTicketView, type KnowledgeStore, type TicketStore } from './store.ts';
import {
  readEnum, readObject, readOptionalInt, readString, type BusinessTool, type ToolContext,
} from './tools.ts';
import type { TicketStatus } from './types.ts';

const REVISION_SCHEMA = {
  type: 'integer',
  minimum: 1,
  description: 'request.ticket.revision；防止覆盖他人刚提交的修改',
};

export function createSupportTools(tickets: TicketStore, knowledge: KnowledgeStore): BusinessTool<any, any>[] {
  const getTicket = async (context: ToolContext) => {
    const ticket = await context.tickets.get(context.ticketId, context.signal);
    if (ticket === undefined) throw new BusinessError('not_found', `工单不存在：${context.ticketId}`);
    return ticket;
  };

  return [
    {
      name: 'ticket.get',
      description: '读取当前工单的最新版本。发生 revision 冲突或需要确认外部变更时使用。',
      effect: 'read',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      parse(raw) {
        return readObject(raw, [], [], 'ticket.get');
      },
      async execute(_input, context) {
        return toTicketView(await getTicket(context));
      },
    },
    {
      name: 'knowledge.search',
      description: '检索业务知识库，为回复草稿提供依据。返回匹配条目与 id。',
      effect: 'read',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 120 },
          limit: { type: 'integer', minimum: 1, maximum: 5, default: 3 },
        },
      },
      parse(raw) {
        const args = readObject(raw, ['query', 'limit'], ['query'], 'knowledge.search');
        return {
          query: readString(args, 'query', 1, 120, 'knowledge.search'),
          limit: readOptionalInt(args, 'limit', 1, 5, 3, 'knowledge.search'),
        };
      },
      async execute(input, context) {
        return context.knowledge.search(input.query, input.limit, context.signal);
      },
    },
    {
      name: 'ticket.draftReply',
      description: '保存回复草稿，不发送给客户。需要最新 revision；写入后 revision 会增加。',
      effect: 'draft',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['expectedRevision', 'text'],
        properties: {
          expectedRevision: REVISION_SCHEMA,
          text: { type: 'string', minLength: 10, maxLength: 4000 },
        },
      },
      parse(raw) {
        const args = readObject(raw, ['expectedRevision', 'text'], ['expectedRevision', 'text'], 'ticket.draftReply');
        return {
          expectedRevision: readRevision(args, 'ticket.draftReply'),
          text: readString(args, 'text', 10, 4000, 'ticket.draftReply'),
        };
      },
      async execute(input, context) {
        const updated = await context.tickets.update(
          context.ticketId,
          input.expectedRevision,
          { draftReply: input.text },
          context.signal,
        );
        return toTicketView(updated);
      },
    },
    {
      name: 'ticket.addNote',
      description: '添加内部备注，不发送给客户。用于记录证据、判断依据或待人工核对项。',
      effect: 'draft',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['expectedRevision', 'text'],
        properties: {
          expectedRevision: REVISION_SCHEMA,
          text: { type: 'string', minLength: 1, maxLength: 2000 },
        },
      },
      parse(raw) {
        const args = readObject(raw, ['expectedRevision', 'text'], ['expectedRevision', 'text'], 'ticket.addNote');
        return {
          expectedRevision: readRevision(args, 'ticket.addNote'),
          text: readString(args, 'text', 1, 2000, 'ticket.addNote'),
        };
      },
      async execute(input, context) {
        const updated = await context.tickets.update(
          context.ticketId,
          input.expectedRevision,
          { internalNote: input.text },
          context.signal,
        );
        return toTicketView(updated);
      },
    },
    {
      name: 'ticket.setStatus',
      description: '外部副作用：改变工单状态。默认不暴露；只有配置审批网关且 token 有效时才可出现。',
      effect: 'external',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['expectedRevision', 'status', 'approvalToken'],
        properties: {
          expectedRevision: REVISION_SCHEMA,
          status: { type: 'string', enum: ['pending_customer', 'resolved'] },
          approvalToken: { type: 'string', minLength: 8, maxLength: 512 },
        },
      },
      parse(raw) {
        const args = readObject(
          raw,
          ['expectedRevision', 'status', 'approvalToken'],
          ['expectedRevision', 'status', 'approvalToken'],
          'ticket.setStatus',
        );
        return {
          expectedRevision: readRevision(args, 'ticket.setStatus'),
          status: readEnum(args, 'status', ['pending_customer', 'resolved'] as const, 'ticket.setStatus'),
          approvalToken: readString(args, 'approvalToken', 8, 512, 'ticket.setStatus'),
        };
      },
      approvalToken(input) {
        return input.approvalToken;
      },
      async execute(input, context) {
        const updated = await context.tickets.update(
          context.ticketId,
          input.expectedRevision,
          { status: input.status as TicketStatus },
          context.signal,
        );
        return toTicketView(updated);
      },
    },
  ];
}

function readRevision(args: Record<string, unknown>, toolName: string): number {
  const value = args['expectedRevision'];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new BusinessError('invalid_args', `${toolName}.expectedRevision 必须是正整数，取自 request.ticket.revision。`);
  }
  return value;
}
