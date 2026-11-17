// FALLBACK-AUTHORED registry functions — media generation vendors.
// Basis: MiniMax platform docs, BytePlus ModelArk docs, Alibaba Cloud Model
// Studio docs, 2026-09-08. REGENERATE through scripts/generate-registry when
// machine-readable specs are wired for these vendors.
//
// Video and music generation are ASYNC JOB-SHAPED: submit returns a job id,
// poll reads status, fetch returns the artifact. Modeled as explicit
// submit/poll/fetch functions (the apify runs surface is the precedent)
// rather than one long-blocking call — a workflow step or assistant turn must
// never hold a connection open for a multi-minute render.
//
// Generation has no side effect on any external system, so every function is
// 'read' for classification purposes; spend control is the metering layer's
// job, not the sensitivity taxonomy's.

import type { ConnectorFunction } from '../../types.js';

export const MINIMAX_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'generate_image',
    description: 'Generate an image from a text prompt',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to generate' },
        aspect_ratio: { type: 'string', description: 'For example 1:1 or 16:9' },
      },
      required: ['prompt'],
    },
    categories: ['read'],
  },
  {
    name: 'generate_speech',
    description: 'Generate spoken audio from text',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to speak' },
        voice_id: { type: 'string', description: 'Voice to use' },
      },
      required: ['text'],
    },
    categories: ['read'],
  },
  {
    name: 'submit_video_job',
    description: 'Start a video generation job; returns a job id to poll',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to generate' },
        model: { type: 'string', description: 'Video model name' },
        duration_seconds: { type: 'number', description: 'Requested length' },
      },
      required: ['prompt'],
    },
    categories: ['read'],
  },
  {
    name: 'submit_music_job',
    description: 'Start a music generation job; returns a job id to poll',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Style and content description' },
        lyrics: { type: 'string', description: 'Optional lyrics' },
      },
      required: ['prompt'],
    },
    categories: ['read'],
  },
  {
    name: 'get_job_result',
    description: 'Poll a generation job; returns status and, when finished, the artifact reference',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job id from a submit call' },
      },
      required: ['job_id'],
    },
    categories: ['read'],
  },
];

export const BYTEDANCE_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'submit_video_job',
    description: 'Start a Seedance video generation job; returns a job id to poll',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to generate' },
        model: { type: 'string', description: 'Seedance model name' },
        resolution: { type: 'string', description: 'For example 720p or 1080p' },
        duration_seconds: { type: 'number', description: 'Requested length' },
      },
      required: ['prompt'],
    },
    categories: ['read'],
  },
  {
    name: 'get_job_result',
    description: 'Poll a Seedance job; returns status and, when finished, the video reference',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job id from a submit call' },
      },
      required: ['job_id'],
    },
    categories: ['read'],
  },
];

export const ALIBABA_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'generate_image',
    description: 'Generate an image with a Wan or Qwen image model from a text prompt',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to generate' },
        model: { type: 'string', description: 'Image model name' },
        size: { type: 'string', description: 'For example 1024*1024' },
      },
      required: ['prompt'],
    },
    categories: ['read'],
  },
  {
    name: 'submit_video_job',
    description: 'Start a Wan video generation job; returns a job id to poll',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to generate' },
        model: { type: 'string', description: 'Wan video model name' },
        image_url: { type: 'string', description: 'Optional first-frame image for image-to-video' },
      },
      required: ['prompt'],
    },
    categories: ['read'],
  },
  {
    name: 'get_job_result',
    description: 'Poll a Model Studio job; returns status and, when finished, the artifact reference',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job id from a submit call' },
      },
      required: ['job_id'],
    },
    categories: ['read'],
  },
];
