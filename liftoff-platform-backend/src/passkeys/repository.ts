// Passkey Repository
// WebAuthn credential storage

import { getPool } from '../infrastructure/database';
import { Passkey, CreatePasskeyInput } from './types';

export class PasskeyRepository {
  async create(input: CreatePasskeyInput): Promise<Passkey> {
    const pool = getPool();
    const result = await pool.query(
      `INSERT INTO passkeys (user_id, credential_id, public_key, counter, device_name, transports)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.userId,
        input.credentialId,
        input.publicKey,
        input.counter,
        input.deviceName || null,
        input.transports || null,
      ]
    );
    return this.mapRow(result.rows[0]);
  }

  async findById(id: string): Promise<Passkey | null> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM passkeys WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async findByCredentialId(credentialId: string): Promise<Passkey | null> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM passkeys WHERE credential_id = $1`,
      [credentialId]
    );
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async findByUserId(userId: string): Promise<Passkey[]> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM passkeys WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId]
    );
    return result.rows.map(this.mapRow);
  }

  async updateCounter(id: string, counter: number): Promise<Passkey> {
    const pool = getPool();
    const result = await pool.query(
      `UPDATE passkeys SET counter = $2, last_used_at = NOW() WHERE id = $1 RETURNING *`,
      [id, counter]
    );
    if (!result.rows[0]) {
      throw new Error(`Passkey not found: ${id}`);
    }
    return this.mapRow(result.rows[0]);
  }

  async delete(id: string, userId: string): Promise<boolean> {
    const pool = getPool();
    const result = await pool.query(
      `DELETE FROM passkeys WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    return result.rowCount !== null && result.rowCount > 0;
  }

  private mapRow(row: Record<string, unknown>): Passkey {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      credentialId: row.credential_id as string,
      publicKey: row.public_key as string,
      counter: row.counter as number,
      deviceName: row.device_name as string | null,
      transports: row.transports as string[] | null,
      createdAt: row.created_at as Date,
      lastUsedAt: row.last_used_at as Date | null,
    };
  }
}
