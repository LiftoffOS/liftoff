import { EventEmitter } from 'node:events';
import type { BrowserSessionEvent } from './types';

let emitter: EventEmitter | null = null;

export function getBrowserSessionEmitter(): EventEmitter {
  if (!emitter) {
    emitter = new EventEmitter();
    emitter.setMaxListeners(0);
  }
  return emitter;
}

export function emitBrowserSessionEvent(event: BrowserSessionEvent): void {
  getBrowserSessionEmitter().emit('event', event);
}
