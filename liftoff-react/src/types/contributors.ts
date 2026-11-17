/**
 * Who else had a hand in a reply, mirrored once for the whole frontend.
 *
 * The definition of record is @liftoffos/chat-attachments, published from the
 * platform backend and consumed by it, the workforce service and the tenant
 * runtime. This is the single React copy of it, for the reason MediaRef has
 * one: a browser bundle does not pull a private-registry package for two
 * fields, and every chat surface's wire type carries `contributors` while one
 * renderer draws the chips, so there is nothing per surface to keep in step.
 * Change one, change the other.
 *
 * A contributor is a colleague OTHER than the assistant whose page this is,
 * who had a hand in the reply. On Liftoff a hand-over puts the colleague who
 * wrote the whole reply here (the one-element case); on team chat each
 * teammate the team delegated part of the work to is listed, in the order
 * they were first brought in; the Chief AI Officer and the Insights Manager
 * carry the same field so a colleague of theirs is attributed the same way
 * the day one exists. The same shape rides the `delegation_started` frame,
 * so a live reply is attributed exactly as the stored one will be.
 *
 * It lives in types/ rather than beside the renderer because the four chat
 * service modules need it too, and a service importing a type out of a
 * component would invert the layering for no gain.
 */
export interface Contributor {
  /** `'caio'`, `'insights'`, `'liftoff'`, or an agent's id. */
  id: string
  /** The display name as the person saw it, stored beside the reply rather
   *  than resolved on read, so renaming or deleting a team never relabels an
   *  answer somebody has already had. */
  label: string
}
