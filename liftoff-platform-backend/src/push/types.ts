export interface PushSubscriptionRow {
  id: string;
  accountId: string;
  /** Firebase Installation ID — how FCM addresses this device. The only
   *  identifier now: the legacy `fcm_token` column and every path that read it
   *  were removed once the last device had re-registered. */
  fid: string;
  origin: string;
  userAgent: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
}

/** What a push carries. Deliberately narrower than the notification payload:
 *  a notification body is read on a lock screen, so only the fields that fit
 *  there are carried, plus the link the click resolves. */
export interface PushMessage {
  title: string;
  body: string;
  /** Absolute URL the notification click opens. This is the opaque
   *  /notification/<id> link, never a URL carrying internal ids. */
  link: string;
  /** Collapse key. Two messages sharing a tag replace each other rather than
   *  stacking, so a burst of replies in one thread stays one notification. */
  tag: string;
}
