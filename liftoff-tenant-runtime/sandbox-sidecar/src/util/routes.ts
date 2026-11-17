import { Router } from 'express';
import { convertToMarkdown } from './markitdown';
import { asyncHandler } from '../shared/error-middleware';

export const utilRoutes = Router();

utilRoutes.post(
  '/convertToMarkdown',
  asyncHandler(async (req, res) => {
    const body = req.body as { path?: string; content?: string; mime?: string };
    res.json(await convertToMarkdown(body));
  }),
);
