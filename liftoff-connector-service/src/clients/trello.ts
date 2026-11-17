// Trello Connector Client
// Auth: API key (env var TRELLO_API_KEY) + OAuth token (credentials.accessToken)
// Both are passed as query params on every request — no refresh needed.
// Base URL: https://api.trello.com/1

import {
  CompensationClient,
  CredentialProvider,
  ExternalRecord,
  CreateResult,
  UpdateResult,
  DeleteResult,
  ListFilters,
  ListResult,
} from './types.js';
import { logger } from '../infra/logging.js';

const BASE_URL = 'https://api.trello.com/1';

export class TrelloClient implements CompensationClient {
  readonly connector = 'trello';
  private credentialProvider: CredentialProvider;

  constructor(credentialProvider: CredentialProvider) {
    this.credentialProvider = credentialProvider;
  }

  /**
   * Build the full request URL, appending the mandatory key+token auth params
   * plus any caller-supplied query params.
   */
  private buildUrl(path: string, params: Record<string, string> = {}): string {
    const apiKey = process.env.TRELLO_API_KEY;
    if (!apiKey) {
      throw new Error('TRELLO_API_KEY environment variable is not set');
    }
    const qs = new URLSearchParams({ key: apiKey, ...params });
    return `${BASE_URL}${path}?${qs.toString()}`;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, any>,
    queryParams: Record<string, string> = {},
  ): Promise<T> {
    // Fetch credentials fresh per-request so the token is never stale.
    const credentials = await this.credentialProvider();

    const url = this.buildUrl(path, {
      token: credentials.accessToken,
      ...queryParams,
    });

    const response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error('Trello API error', { status: response.status, error, path, method });
      throw new Error(`Trello API error: ${response.status} - ${error}`);
    }

    // 204 No Content
    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  // ── Board operations ────────────────────────────────────────────────────────

  async listBoards(): Promise<unknown[]> {
    return this.request<unknown[]>('GET', '/members/me/boards', undefined, {
      fields: 'id,name,desc,closed,url',
    });
  }

  async getBoard(boardId: string): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('GET', `/boards/${boardId}`);
  }

  async listLists(boardId: string): Promise<unknown[]> {
    return this.request<unknown[]>('GET', `/boards/${boardId}/lists`, undefined, {
      filter: 'open',
    });
  }

  async listBoardCards(boardId: string): Promise<unknown[]> {
    return this.request<unknown[]>('GET', `/boards/${boardId}/cards`, undefined, {
      filter: 'open',
    });
  }

  async listBoardMembers(boardId: string): Promise<unknown[]> {
    return this.request<unknown[]>('GET', `/boards/${boardId}/members`);
  }

  // ── List operations ─────────────────────────────────────────────────────────

  async listListCards(listId: string): Promise<unknown[]> {
    return this.request<unknown[]>('GET', `/lists/${listId}/cards`);
  }

  async createList(data: { name: string; idBoard: string; pos?: string }): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('POST', '/lists', data);
  }

  async updateList(listId: string, data: Record<string, any>): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('PUT', `/lists/${listId}`, data);
  }

  async archiveList(listId: string): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('PUT', `/lists/${listId}/closed`, { value: true });
  }

  async createBoard(data: { name: string; desc?: string; defaultLists?: boolean }): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('POST', '/boards', { ...data, defaultLists: data.defaultLists ?? false });
  }

  async updateBoard(boardId: string, data: Record<string, any>): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('PUT', `/boards/${boardId}`, data);
  }

  // ── Card operations ─────────────────────────────────────────────────────────

  async getCard(cardId: string): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('GET', `/cards/${cardId}`);
  }

  async createCard(data: {
    idList: string;
    name: string;
    desc?: string;
    due?: string;
    idMembers?: string[];
  }): Promise<Record<string, any>> {
    const body: Record<string, any> = {
      idList: data.idList,
      name: data.name,
    };
    if (data.desc !== undefined) body.desc = data.desc;
    if (data.due !== undefined) body.due = data.due;
    if (data.idMembers !== undefined) body.idMembers = data.idMembers;
    return this.request<Record<string, any>>('POST', '/cards', body);
  }

  async updateCard(cardId: string, data: Record<string, any>): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('PUT', `/cards/${cardId}`, data);
  }

  async deleteCard(cardId: string): Promise<void> {
    await this.request<void>('DELETE', `/cards/${cardId}`);
  }

  async addCardComment(cardId: string, text: string): Promise<Record<string, any>> {
    return this.request<Record<string, any>>(
      'POST',
      `/cards/${cardId}/actions/comments`,
      { text },
    );
  }

  async getCardComments(cardId: string): Promise<unknown[]> {
    return this.request<unknown[]>('GET', `/cards/${cardId}/actions`, undefined, {
      filter: 'commentCard',
    });
  }

  // ── CompensationClient interface ────────────────────────────────────────────

  /**
   * read() — maps entity type to the correct Trello API call.
   *
   * Supported entityTypes:
   *   - 'boards'          → listBoards()
   *   - 'board'           → getBoard(id)
   *   - 'lists'           → listLists(options.boardId)
   *   - 'cards'           → listBoardCards(options.boardId) OR listListCards(id)
   *   - 'card'            → getCard(id)
   *   - 'card_comments'   → getCardComments(id)
   *   - 'board_members'   → listBoardMembers(options.boardId or id)
   */
  async read(
    entityType: string,
    entityId: string | undefined,
    payload?: Record<string, any>,
  ): Promise<ExternalRecord> {
    logger.info('Trello read', { entityType, entityId });

    switch (entityType) {
      case 'boards': {
        const data = await this.listBoards();
        return { id: 'boards', data: { boards: data } };
      }

      case 'board': {
        if (!entityId) throw new Error('Trello: board read requires entityId (boardId)');
        const data = await this.getBoard(entityId);
        return { id: entityId, data };
      }

      case 'lists': {
        const boardId = payload?.boardId as string | undefined;
        if (!boardId) throw new Error('Trello: lists read requires boardId in payload');
        const data = await this.listLists(boardId);
        return { id: boardId, data: { lists: data } };
      }

      case 'cards': {
        const boardId = payload?.boardId as string | undefined;
        const listId = payload?.listId as string | undefined;
        if (boardId) {
          const data = await this.listBoardCards(boardId);
          return { id: boardId, data: { cards: data } };
        } else if (listId) {
          const data = await this.listListCards(listId);
          return { id: listId, data: { cards: data } };
        }
        throw new Error('Trello: cards read requires boardId or listId in payload');
      }

      case 'card': {
        if (!entityId) throw new Error('Trello: card read requires entityId (cardId)');
        const data = await this.getCard(entityId);
        return { id: entityId, data };
      }

      case 'card_comments': {
        if (!entityId) throw new Error('Trello: card_comments read requires entityId (cardId)');
        const data = await this.getCardComments(entityId);
        return { id: entityId, data: { comments: data } };
      }

      case 'board_members': {
        const boardId = (payload?.boardId as string | undefined) ?? entityId;
        if (!boardId) throw new Error('Trello: board_members read requires boardId');
        const data = await this.listBoardMembers(boardId);
        return { id: boardId, data: { members: data } };
      }

      default:
        throw new Error(`Trello: unsupported read entity type "${entityType}"`);
    }
  }

  /**
   * create() — maps entity type to the correct Trello write operation.
   *
   * Supported entityTypes:
   *   - 'card'    → createCard(data)
   *   - 'comment' → addCardComment(data.cardId, data.text)
   */
  /** Enumerate boards, lists or cards.
   *
   *  The enumerators below already existed for the tool surface; only `list`
   *  never called them, so anything asking this client what a workspace holds
   *  got an empty array and reported it as "you have no boards".
   *
   *  Lists and cards live under a board, so they need `filters.folderId` to say
   *  which one. Missing that is a statement about the request, not about our
   *  coverage, and so is NOT reported as unsupported. */
  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    const parent = (filters as Record<string, unknown> | undefined)?.folderId as string | undefined;

    const toRecords = (rows: unknown[]): ExternalRecord[] =>
      rows.map(row => {
        const r = row as Record<string, any>;
        return { id: String(r.id), data: r };
      });

    switch (entityType) {
      case 'board':
      case 'boards':
        return { records: toRecords(await this.listBoards()), hasMore: false };

      case 'list':
      case 'lists':
        if (!parent) return { records: [], hasMore: false };
        return { records: toRecords(await this.listLists(parent)), hasMore: false };

      case 'card':
      case 'cards':
        if (!parent) return { records: [], hasMore: false };
        return { records: toRecords(await this.listBoardCards(parent)), hasMore: false };

      default:
        return { records: [], hasMore: false, unsupported: true };
    }
  }


  async create(entityType: string, data: Record<string, any>): Promise<CreateResult> {
    logger.info('Trello create', { entityType });

    try {
      switch (entityType) {
        case 'card': {
          const result = await this.createCard({
            idList: data.idList as string,
            name: data.name as string,
            desc: data.desc as string | undefined,
            due: data.due as string | undefined,
            idMembers: data.idMembers as string[] | undefined,
          });
          return { success: true, id: String(result.id), data: result };
        }

        case 'comment': {
          const cardId = data.cardId as string;
          const text = data.text as string;
          if (!cardId) return { success: false, id: '', error: 'Trello: comment create requires cardId' };
          if (!text) return { success: false, id: '', error: 'Trello: comment create requires text' };
          const result = await this.addCardComment(cardId, text);
          return { success: true, id: String((result as Record<string, any>).id ?? ''), data: result };
        }

        case 'list': {
          const result = await this.createList({
            name: data.name as string,
            idBoard: data.idBoard as string,
            pos: data.pos as string | undefined,
          });
          return { success: true, id: String((result as Record<string, any>).id ?? ''), data: result };
        }

        case 'board': {
          const result = await this.createBoard({
            name: data.name as string,
            desc: data.desc as string | undefined,
          });
          return { success: true, id: String((result as Record<string, any>).id ?? ''), data: result };
        }

        default:
          return {
            success: false,
            id: '',
            error: `Trello: unsupported create entity type "${entityType}"`,
          };
      }
    } catch (error) {
      return { success: false, id: '', error: (error as Error).message };
    }
  }

  /**
   * update() — maps entity type to the correct Trello update operation.
   *
   * Supported entityTypes:
   *   - 'card' → updateCard(id, data)
   */
  async update(
    entityType: string,
    entityId: string | undefined,
    data: Record<string, any>,
  ): Promise<UpdateResult> {
    logger.info('Trello update', { entityType, entityId });

    try {
      switch (entityType) {
        case 'card': {
          if (!entityId) return { success: false, error: 'Trello: card update requires entityId' };
          const result = await this.updateCard(entityId, data);
          return { success: true, data: result };
        }

        case 'list': {
          if (!entityId) return { success: false, error: 'Trello: list update requires entityId' };
          const result = await this.updateList(entityId, data);
          return { success: true, data: result };
        }

        case 'board': {
          if (!entityId) return { success: false, error: 'Trello: board update requires entityId' };
          const result = await this.updateBoard(entityId, data);
          return { success: true, data: result };
        }

        default:
          return {
            success: false,
            error: `Trello: unsupported update entity type "${entityType}"`,
          };
      }
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * delete() — maps entity type to the correct Trello delete operation.
   *
   * Supported entityTypes:
   *   - 'card' → deleteCard(id)
   */
  async delete(
    entityType: string,
    entityId: string | undefined,
    _payload?: Record<string, any>,
  ): Promise<DeleteResult> {
    logger.info('Trello delete', { entityType, entityId });

    try {
      if (entityType === 'card') {
        if (!entityId) return { success: false, error: 'Trello: card delete requires entityId' };
        await this.deleteCard(entityId);
        return { success: true };
      }

      if (entityType === 'list') {
        if (!entityId) return { success: false, error: 'Trello: list delete requires entityId' };
        await this.archiveList(entityId);
        return { success: true };
      }

      if (entityType === 'board') {
        if (!entityId) return { success: false, error: 'Trello: board delete requires entityId' };
        // Trello boards can only be closed (archived), not permanently deleted via API
        await this.updateBoard(entityId, { closed: true });
        return { success: true };
      }

      return {
        success: false,
        error: `Trello: unsupported delete entity type "${entityType}"`,
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  // ── CompensationClient — snapshot / inverse ─────────────────────────────────

  async restore(
    entityType: string,
    entityId: string | undefined,
    snapshot: Record<string, any>,
  ): Promise<UpdateResult> {
    logger.info('Trello restore from snapshot', { entityType, entityId });
    return this.update(entityType, entityId, snapshot);
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    entityId: string | undefined,
    originalResponse: Record<string, any>,
  ): Promise<DeleteResult | UpdateResult> {
    logger.info('Trello semantic inverse', { entityType, originalAction, entityId });

    switch (originalAction) {
      case 'create':
        if (entityType === 'card') {
          const id = entityId ?? (originalResponse.id as string | undefined);
          return this.delete('card', id);
        }
        return { success: false, error: `Cannot invert create for entity type "${entityType}"` };

      case 'delete':
        return {
          success: false,
          error: 'Cannot restore deleted Trello cards — deletion is permanent',
        };

      case 'update':
        return {
          success: false,
          error: 'Update reversal requires a pre-action snapshot',
        };

      default:
        return {
          success: false,
          error: `Unknown action type: ${originalAction}`,
        };
    }
  }
}
