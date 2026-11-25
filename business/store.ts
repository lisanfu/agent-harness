import { BusinessError } from './errors.ts';
import type { KnowledgeDocument, TicketRecord, TicketStatus, TicketView } from './types.ts';

export interface TicketPatch {
  draftReply?: string;
  internalNote?: string;
  status?: TicketStatus;
}

/**
 * 业务存储端口。生产适配器应在一个事务里完成 revision 检查与写入，
 * 并按租户/用户做行级权限过滤；runtime 不直接接触 SQL 或 HTTP 凭据。
 */
export interface TicketStore {
  get(ticketId: string, signal: AbortSignal): Promise<TicketRecord | undefined>;
  update(
    ticketId: string,
    expectedRevision: number,
    patch: TicketPatch,
    signal: AbortSignal,
  ): Promise<TicketRecord>;
}

export interface KnowledgeStore {
  search(query: string, limit: number, signal: AbortSignal): Promise<KnowledgeDocument[]>;
}

export function toTicketView(ticket: TicketRecord): TicketView {
  return {
    id: ticket.id,
    subject: ticket.subject,
    customerMessage: ticket.customerMessage,
    status: ticket.status,
    revision: ticket.revision,
    tags: [...ticket.tags],
    draftReply: ticket.draftReply,
  };
}

function cloneTicket(ticket: TicketRecord): TicketRecord {
  return { ...ticket, tags: [...ticket.tags], internalNotes: [...ticket.internalNotes] };
}

/** 仅用于示例与测试：进程重启后数据会丢失。 */
export class InMemoryTicketStore implements TicketStore {
  private readonly tickets = new Map<string, TicketRecord>();

  constructor(tickets: TicketRecord[]) {
    for (const ticket of tickets) this.tickets.set(ticket.id, cloneTicket(ticket));
  }

  async get(ticketId: string, signal: AbortSignal): Promise<TicketRecord | undefined> {
    signal.throwIfAborted();
    const ticket = this.tickets.get(ticketId);
    return ticket === undefined ? undefined : cloneTicket(ticket);
  }

  async update(
    ticketId: string,
    expectedRevision: number,
    patch: TicketPatch,
    signal: AbortSignal,
  ): Promise<TicketRecord> {
    signal.throwIfAborted();
    const current = this.tickets.get(ticketId);
    if (current === undefined) throw new BusinessError('not_found', `工单不存在：${ticketId}`);
    if (current.revision !== expectedRevision) {
      throw new BusinessError(
        'conflict',
        `工单版本冲突：期望 revision=${expectedRevision}，当前 revision=${current.revision}；请先 ticket.get 读取最新版本。`,
      );
    }
    const next: TicketRecord = {
      ...current,
      revision: current.revision + 1,
      tags: [...current.tags],
      internalNotes: [...current.internalNotes],
      ...(patch.draftReply === undefined ? {} : { draftReply: patch.draftReply }),
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.internalNote === undefined ? {} : { internalNotes: [...current.internalNotes, patch.internalNote] }),
    };
    signal.throwIfAborted();
    this.tickets.set(ticketId, next);
    return cloneTicket(next);
  }
}

/** 示例检索器只做确定性的关键词匹配，不是模型，也不是生产搜索引擎。 */
export class InMemoryKnowledgeStore implements KnowledgeStore {
  private readonly documents: KnowledgeDocument[];

  constructor(documents: KnowledgeDocument[]) {
    this.documents = documents;
  }

  async search(query: string, limit: number, signal: AbortSignal): Promise<KnowledgeDocument[]> {
    signal.throwIfAborted();
    const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return this.documents
      .map((document) => {
        const haystack = `${document.title}\n${document.content}\n${document.tags.join(' ')}`.toLocaleLowerCase();
        const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
        return { document, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.document.id.localeCompare(b.document.id))
      .slice(0, limit)
      .map(({ document }) => ({ ...document, tags: [...document.tags] }));
  }
}

export function createDemoStores(): { tickets: TicketStore; knowledge: KnowledgeStore } {
  return {
    tickets: new InMemoryTicketStore([
      {
        id: 'T-1001',
        subject: '退货后的退款多久到账',
        customerMessage: '我已经把商品寄回去了，想确认退款什么时候到账，以及是否需要补充凭证。',
        status: 'open',
        revision: 1,
        tags: ['退款', '物流'],
        draftReply: null,
        internalNotes: ['示例数据：不含真实客户信息。'],
      },
      {
        id: 'T-1002',
        subject: '优惠券能否叠加使用',
        customerMessage: '我有两张优惠券，结账时只能使用一张，请问可以叠加吗？',
        status: 'open',
        revision: 1,
        tags: ['优惠券'],
        draftReply: null,
        internalNotes: [],
      },
    ]),
    knowledge: new InMemoryKnowledgeStore([
      {
        id: 'KB-REFUND-01',
        title: '退货退款时效',
        content: '仓库签收并验收后，退款会在 1 至 3 个工作日内原路退回。若超过 3 个工作日，请提供退货物流单号。',
        tags: ['退款', '退货', '到账', '工作日'],
      },
      {
        id: 'KB-COUPON-01',
        title: '优惠券叠加规则',
        content: '每笔订单只能使用一张优惠券；满减券与折扣券不可叠加，系统会自动选择优惠金额更高的一张。',
        tags: ['优惠券', '叠加', '满减', '折扣'],
      },
    ]),
  };
}
