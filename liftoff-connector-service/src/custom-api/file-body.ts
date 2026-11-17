// Putting a file on the wire, from an id a model named.
//
// A model cannot hold bytes and must never be asked to relay them: a file
// pasted into a conversation is a file the model has read, mangled by whatever
// encoding it guessed, and sitting in a context window. So an operation that
// takes a file takes an ID — of something already in the workspace, produced
// by an AI team or attached by a person — and the bytes are fetched here, at
// dispatch, and never pass through a model at all.
//
// This is the upload half of the same idea as a download: the provider deals
// in bytes, the workspace deals in files, and the model deals in names.

import { readWorkspaceFile, WorkspaceFileError } from './workspace-files.js';

export interface BuiltFileBody {
  payload: FormData | Buffer;
  /** Absent for a form: `FormData` sets its own type, and the boundary in it
   *  is not something a caller can write. */
  contentType?: string;
}

/**
 * Build a request body that carries one or more files.
 *
 * Two shapes, and which one is decided by what the specification declared:
 *
 *   multipart/form-data  every field is sent, and a file field is sent as its
 *                        bytes under its own name — mixed with the ordinary
 *                        fields beside it, which is what a form is for.
 *   a raw binary body    the file IS the payload, so the bytes go on the wire
 *                        alone, under the provider's own content type.
 */
export async function buildFileBody(args: {
  tenantId: string;
  body: Record<string, unknown>;
  fileParams: readonly string[];
  mediaType: string | undefined;
}): Promise<BuiltFileBody> {
  const { tenantId, body, fileParams, mediaType } = args;

  if (mediaType === 'multipart/form-data') {
    const form = new FormData();
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined || value === null) continue;
      if (fileParams.includes(key)) {
        const file = await resolve(tenantId, key, value);
        form.append(key, new Blob([new Uint8Array(file.bytes)], { type: file.mimeType }), file.filename);
        continue;
      }
      // Everything that is not a file goes as a field. An object is sent as
      // JSON text, which is the only reading a form has for one.
      form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    return { payload: form };
  }

  // A raw binary body: one file and nothing else. Whichever field carries it,
  // the bytes are the whole payload.
  const named = fileParams.find((name) => body[name] !== undefined && body[name] !== null);
  if (!named) {
    throw new WorkspaceFileError(
      'rejected',
      `custom_api: this operation sends a file and none was named. Give it the id of a file in this workspace (${fileParams.join(', ')}).`,
    );
  }
  const file = await resolve(tenantId, named, body[named]);
  return {
    payload: file.bytes,
    // The provider's declared type when it named one, and otherwise the type
    // the stored file says it is — never a guess of our own.
    contentType: mediaType && mediaType !== 'multipart/form-data' ? mediaType : file.mimeType,
  };
}

async function resolve(
  tenantId: string,
  field: string,
  value: unknown,
): Promise<{ bytes: Buffer; filename: string; mimeType: string }> {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WorkspaceFileError(
      'rejected',
      `custom_api: "${field}" takes the id of a file in this workspace, not its contents.`,
    );
  }
  return readWorkspaceFile({ tenantId, fileId: value.trim() });
}
