import { Router } from 'express';
import { asyncHandler } from '../shared/error-middleware';
import { SandboxApiError } from '../shared/errors';
import { SANDBOX_ERROR_CODES } from '@liftoffos/sandbox-contracts';
import { nodeReplManager } from '../nodejs/repl-session';
import { bashSessionManager } from '../bash/session-manager';

const SUPPORTED = ['python', 'javascript', 'bash'];

export const codeRoutes = Router();

codeRoutes.post(
  '/execute',
  asyncHandler(async (req, res) => {
    const { language, code, session_id, timeout_ms } = req.body as { language: string; code: string; session_id?: string; timeout_ms?: number };
    if (!SUPPORTED.includes(language)) {
      throw new SandboxApiError(SANDBOX_ERROR_CODES.UNSUPPORTED_LANGUAGE, 400, 'unsupported language', { supported: SUPPORTED });
    }
    let sid = session_id;
    if (language === 'javascript') {
      const session = sid ? nodeReplManager.get(sid) : nodeReplManager.create();
      sid = session.sessionId;
      const result = await session.execute(code);
      res.json({ session_id: sid, ...result });
      return;
    }
    // python or bash share the bash session manager
    const session = sid ? bashSessionManager.get(sid) : bashSessionManager.create();
    sid = session.sessionId;
    const args = language === 'python' ? ['python3', '-c', code] : ['bash', '-c', code];
    const result = await session.exec(args, timeout_ms ?? 30_000);
    res.json({ session_id: sid, ...result });
  }),
);

codeRoutes.get(
  '/info',
  asyncHandler(async (_req, res) => {
    res.json({ languages: SUPPORTED });
  }),
);
