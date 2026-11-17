import { timeOfDayGreeting } from "./greeting";

describe("timeOfDayGreeting", () => {
  const timezone = "America/New_York";

  // January 15, 2024 08:00 EST = January 15, 2024 13:00 UTC
  const jan15_8am_est = new Date("2024-01-15T13:00:00Z"); // 8 AM EST
  // January 15, 2024 12:00 EST = January 15, 2024 17:00 UTC
  const jan15_12pm_est = new Date("2024-01-15T17:00:00Z"); // 12 PM EST
  // January 15, 2024 17:00 EST = January 15, 2024 22:00 UTC
  const jan15_5pm_est = new Date("2024-01-15T22:00:00Z"); // 5 PM EST
  // January 15, 2024 21:00 EST = January 16, 2024 02:00 UTC
  const jan15_9pm_est = new Date("2024-01-16T02:00:00Z"); // 9 PM EST
  // January 16, 2024 02:00 EST = January 16, 2024 07:00 UTC
  const jan16_2am_est = new Date("2024-01-16T07:00:00Z"); // 2 AM EST
  // January 15, 2024 04:00 EST = January 15, 2024 09:00 UTC
  const jan15_4am_est = new Date("2024-01-15T09:00:00Z"); // 4 AM EST

  test("morning: 8 AM should return 'morning'", () => {
    const greeting = timeOfDayGreeting(timezone, jan15_8am_est);
    expect(greeting).toBe("How can I help you this morning?");
  });

  test("afternoon: 12 PM (noon) should return 'afternoon'", () => {
    const greeting = timeOfDayGreeting(timezone, jan15_12pm_est);
    expect(greeting).toBe("How can I help you this afternoon?");
  });

  test("evening: 5 PM should return 'evening'", () => {
    const greeting = timeOfDayGreeting(timezone, jan15_5pm_est);
    expect(greeting).toBe("How can I help you this evening?");
  });

  test("tonight: 9 PM should return 'tonight'", () => {
    const greeting = timeOfDayGreeting(timezone, jan15_9pm_est);
    expect(greeting).toBe("How can I help you tonight?");
  });

  test("tonight: 2 AM should return 'tonight'", () => {
    const greeting = timeOfDayGreeting(timezone, jan16_2am_est);
    expect(greeting).toBe("How can I help you tonight?");
  });

  test("morning boundary: 4 AM should return 'morning'", () => {
    const greeting = timeOfDayGreeting(timezone, jan15_4am_est);
    expect(greeting).toBe("How can I help you this morning?");
  });

  test("morning boundary: 3 AM should return 'tonight'", () => {
    // January 15, 2024 03:00 EST = January 15, 2024 08:00 UTC
    const jan15_3am_est = new Date("2024-01-15T08:00:00Z"); // 3 AM EST
    const greeting = timeOfDayGreeting(timezone, jan15_3am_est);
    expect(greeting).toBe("How can I help you tonight?");
  });

  test("afternoon boundary: 12 PM should return 'afternoon'", () => {
    expect(timeOfDayGreeting(timezone, jan15_12pm_est)).toBe(
      "How can I help you this afternoon?",
    );
  });

  test("afternoon boundary: 11:59 AM should return 'morning'", () => {
    // January 15, 2024 11:59 EST = January 15, 2024 16:59 UTC
    const jan15_1159am_est = new Date("2024-01-15T16:59:00Z"); // 11:59 AM EST
    const greeting = timeOfDayGreeting(timezone, jan15_1159am_est);
    expect(greeting).toBe("How can I help you this morning?");
  });

  test("evening boundary: 5 PM should return 'evening'", () => {
    expect(timeOfDayGreeting(timezone, jan15_5pm_est)).toBe(
      "How can I help you this evening?",
    );
  });

  test("evening boundary: 4:59 PM should return 'afternoon'", () => {
    // January 15, 2024 16:59 EST = January 15, 2024 21:59 UTC
    const jan15_459pm_est = new Date("2024-01-15T21:59:00Z"); // 4:59 PM EST
    const greeting = timeOfDayGreeting(timezone, jan15_459pm_est);
    expect(greeting).toBe("How can I help you this afternoon?");
  });

  test("tonight boundary: 9 PM should return 'tonight'", () => {
    expect(timeOfDayGreeting(timezone, jan15_9pm_est)).toBe(
      "How can I help you tonight?",
    );
  });

  test("tonight boundary: 8:59 PM should return 'evening'", () => {
    // January 15, 2024 20:59 EST = January 16, 2024 01:59 UTC
    const jan15_859pm_est = new Date("2024-01-16T01:59:00Z"); // 8:59 PM EST
    const greeting = timeOfDayGreeting(timezone, jan15_859pm_est);
    expect(greeting).toBe("How can I help you this evening?");
  });
});
