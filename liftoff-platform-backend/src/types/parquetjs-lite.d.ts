declare module 'parquetjs-lite' {
  export class ParquetSchema {
    constructor(schema: Record<string, unknown>);
  }
  export class ParquetWriter {
    static openFile(schema: ParquetSchema, path: string): Promise<ParquetWriter>;
    static openBuffer(schema: ParquetSchema): Promise<ParquetWriter>;
    appendRow(row: Record<string, unknown>): Promise<void>;
    close(): Promise<void>;
    toBuffer(): Buffer;
  }
  export class ParquetReader {
    static openFile(path: string): Promise<ParquetReader>;
    getCursor(): ParquetCursor;
    close(): Promise<void>;
  }
  export interface ParquetCursor {
    next(): Promise<Record<string, unknown> | null>;
  }
}
