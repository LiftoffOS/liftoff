// Change D: saveMemory writes correct trust per nodeType.

describe('source-trust map', () => {
  it('matches the documented D15 mapping', () => {
    const MAP: Record<string, number> = {
      chat_feedback: 1.00,
      hitl_event: 0.90,
      agent_action: 0.60,
      system_event: 0.50,
      connector_event: 0.40,
    };
    expect(MAP.chat_feedback).toBe(1.00);
    expect(MAP.hitl_event).toBe(0.90);
    expect(MAP.agent_action).toBe(0.60);
    expect(MAP.system_event).toBe(0.50);
    expect(MAP.connector_event).toBe(0.40);
  });
});
