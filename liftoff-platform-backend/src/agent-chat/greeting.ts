// Time-of-day greeting computation, timezone-aware from user's account IANA timezone.

// The bucket used to be interpolated into "How can I help you this ${bucket}?",
// which reads "How can I help you this tonight?" from 9pm to 4am. Whole
// sentences per bucket instead: "tonight" is an adverb and the other three are
// nouns, so no single frame fits all four.
export function timeOfDayGreeting(timezone: string | null | undefined, now: Date = new Date()): string {
  try {
    if (!timezone) return 'How can I help you?';
    return greetingBucket(hourInTimezone(timezone, now));
  } catch {
    return 'How can I help you?';
  }
}

function hourInTimezone(timezone: string, now: Date): number {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    hour12: false,
  }).format(now);
  // Some ICU builds render midnight as "24" under hour12:false — normalize.
  return parseInt(formatted, 10) % 24;
}

function greetingBucket(hour: number): string {
  if (hour >= 4 && hour < 12) return 'How can I help you this morning?';
  if (hour >= 12 && hour < 17) return 'How can I help you this afternoon?';
  if (hour >= 17 && hour < 21) return 'How can I help you this evening?';
  return 'How can I help you tonight?';
}
