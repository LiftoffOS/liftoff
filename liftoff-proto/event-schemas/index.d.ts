// WS-4.5 — type declarations for the event-schemas JSON constants.

export declare const RuntimeConfigUpdatedPayloadSchema: {
  readonly $schema: string;
  readonly type: 'object';
  readonly properties: {
    readonly entityVersion: { readonly type: 'number' };
    readonly agentType: { readonly type: 'string'; readonly enum: readonly ['agent', 'workflow'] };
    readonly hitlLevel: { readonly type: 'integer'; readonly minimum: 1; readonly maximum: 5 };
    readonly modelConfig: { readonly type: 'object' };
    readonly execConfig: { readonly type: 'object' };
    readonly memoryScope: { readonly type: 'object' };
    readonly delegates: { readonly type: 'array' };
    readonly workflowStepsHash: { readonly type: 'string' };
  };
  readonly required: readonly ['agentType', 'hitlLevel', 'modelConfig', 'execConfig', 'memoryScope'];
};
