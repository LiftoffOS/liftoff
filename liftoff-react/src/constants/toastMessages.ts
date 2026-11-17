/**
 * Centralized toast messages for consistent user feedback
 */
export const TOAST_MESSAGES = {
  // Connection messages
  CONNECTION_SUCCESS: 'Connection established successfully',
  CONNECTION_FAILED: 'Failed to connect. Please try again.',
  CONNECTION_REMOVED: 'Connection removed',

  // Team messages
  TEAM_CREATED: 'Team member created successfully',
  TEAM_UPDATED: 'Team member updated successfully',
  TEAM_DELETED: 'Team member removed',
  TEAM_CREATE_FAILED: 'Failed to create team member',
  TEAM_UPDATE_FAILED: 'Failed to update team member',

  // Settings messages
  SETTINGS_SAVED: 'Settings saved successfully',
  SETTINGS_SAVE_FAILED: 'Failed to save settings',
  PASSWORD_UPDATED: 'Password updated successfully',
  PASSWORD_UPDATE_FAILED: 'Failed to update password',

  // Auth messages
  AUTH_ERROR_GENERIC: 'Authentication error. Please try again.',
  SESSION_EXPIRED: 'Your session has expired. Please sign in again.',

  // General messages
  SAVE_SUCCESS: 'Changes saved successfully',
  SAVE_FAILED: 'Failed to save changes',
  DELETE_SUCCESS: 'Deleted successfully',
  DELETE_FAILED: 'Failed to delete',
  COPY_SUCCESS: 'Copied to clipboard',
  GENERIC_ERROR: 'Something went wrong. Please try again.',

  // Validation messages
  VALIDATION_REQUIRED: 'Please fill in all required fields',
  VALIDATION_INVALID: 'Please check your input and try again',
  VALIDATION_TOO_LONG: 'Please be more concise.',

  // Contact form messages
  CONTACT_SUBMIT_FAILED: 'Failed to send your message. Please try again.',
  CONTACT_RATE_LIMITED: 'Please wait before submitting again.',
  CONTACT_TOO_FAST: 'Please take a moment to fill out the form.',

  // Correction messages
  CORRECTION_REQUESTED: 'Correction requested successfully',
  CORRECTION_GATED: 'Correction requires approval',
  CORRECTION_FAILED: 'Failed to request correction',
  CORRECTION_NOT_CORRECTABLE: 'This action cannot be corrected',
} as const

export type ToastMessageKey = keyof typeof TOAST_MESSAGES
