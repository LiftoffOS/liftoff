// Memory Validation
// Per implementation plan: [FIX: SE-004] Content validation and sanitization

import { log } from '../infrastructure/logging';
import {
  MemoryValidationError,
  MAX_CONTENT_LENGTH,
  MAX_TAGS,
  SCOPE_KEY_PATTERN,
  TAG_PATTERN,
} from './types';

// [FIX: SE-004] Content validation
export function validateMemoryContent(content: string): void {
  if (!content || content.length === 0) {
    throw new MemoryValidationError('Content cannot be empty');
  }

  if (content.length > MAX_CONTENT_LENGTH) {
    throw new MemoryValidationError(
      `Content exceeds maximum length of ${MAX_CONTENT_LENGTH} bytes (${content.length} bytes provided)`
    );
  }

  // Check for potential prompt injection patterns
  const suspiciousPatterns = [
    { pattern: /<\|.*\|>/, name: 'Special tokens' },
    { pattern: /\{\{.*\}\}/, name: 'Template injection' },
    { pattern: /\[\[.*\]\]/, name: 'Bracket injection' },
  ];

  for (const { pattern, name } of suspiciousPatterns) {
    if (pattern.test(content)) {
      // Log for security audit, but allow (may be legitimate)
      log.warn({
        patternName: name,
        contentLength: content.length,
      }, 'Suspicious pattern detected in memory content');
    }
  }
}

// Validate scope key format
export function validateScopeKey(scopeKey: string): void {
  if (!scopeKey || scopeKey.length === 0) {
    throw new MemoryValidationError('Scope key cannot be empty');
  }

  if (scopeKey.length > 255) {
    throw new MemoryValidationError('Scope key cannot exceed 255 characters');
  }

  if (!SCOPE_KEY_PATTERN.test(scopeKey)) {
    throw new MemoryValidationError(
      'Scope key must be alphanumeric with underscores/hyphens only'
    );
  }
}

// Validate tags
export function validateTags(tags: string[]): void {
  if (tags.length > MAX_TAGS) {
    throw new MemoryValidationError(
      `Cannot have more than ${MAX_TAGS} tags (${tags.length} provided)`
    );
  }

  for (const tag of tags) {
    if (tag.length > 100) {
      throw new MemoryValidationError('Tag cannot exceed 100 characters');
    }
    if (!TAG_PATTERN.test(tag)) {
      throw new MemoryValidationError(
        `Invalid tag format: ${tag}. Tags must be alphanumeric with underscores, hyphens, colons, dots, or slashes only`
      );
    }
  }
}

// Validate layer
export function validateLayer(layer: string): void {
  const validLayers = ['global', 'role', 'individual', 'conversation'];
  if (!validLayers.includes(layer)) {
    throw new MemoryValidationError(
      `Invalid layer: ${layer}. Must be one of: ${validLayers.join(', ')}`
    );
  }
}

// Validate content classification
export function validateContentClassification(classification: string): void {
  const validClassifications = ['public', 'internal', 'pii', 'sensitive'];
  if (!validClassifications.includes(classification)) {
    throw new MemoryValidationError(
      `Invalid content classification: ${classification}. Must be one of: ${validClassifications.join(', ')}`
    );
  }
}
