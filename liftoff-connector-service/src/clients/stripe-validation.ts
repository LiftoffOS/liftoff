import { MCPError, MCPErrorCode } from '../mcp/mcp-errors.js';

// Validation schemas per entity type
const ENTITY_SCHEMAS: Record<string, EntitySchema> = {
  customer: {
    create: {
      allowed: ['email', 'name', 'phone', 'description', 'metadata', 'address', 'shipping'],
      required: [],
      validators: {
        email: validateEmail,
        metadata: validateMetadata,
      },
    },
    update: {
      allowed: ['email', 'name', 'phone', 'description', 'metadata', 'address', 'shipping'],
      required: [],
      validators: {
        email: validateEmail,
        metadata: validateMetadata,
      },
    },
  },
  subscription: {
    create: {
      allowed: ['customer', 'items', 'metadata', 'trial_period_days', 'cancel_at_period_end'],
      required: ['customer', 'items'],
      validators: {
        customer: validateStripeId('cus_'),
        items: validateSubscriptionItems,
      },
    },
    update: {
      allowed: ['items', 'metadata', 'cancel_at_period_end', 'proration_behavior'],
      required: [],
      validators: {},
    },
  },
  payment_intent: {
    create: {
      allowed: ['amount', 'currency', 'customer', 'metadata', 'description', 'receipt_email'],
      required: ['amount', 'currency'],
      validators: {
        amount: validatePositiveInteger,
        currency: validateCurrency,
        customer: validateStripeId('cus_'),
      },
    },
    update: {
      allowed: ['amount', 'currency', 'customer', 'metadata', 'description'],
      required: [],
      validators: {
        amount: validatePositiveInteger,
      },
    },
  },
  product: {
    create: {
      allowed: ['name', 'description', 'metadata', 'active', 'images', 'url'],
      required: ['name'],
      validators: {
        name: validateNonEmptyString,
        images: validateImageUrls,
      },
    },
    update: {
      allowed: ['name', 'description', 'metadata', 'active', 'images', 'url'],
      required: [],
      validators: {},
    },
  },
  price: {
    create: {
      allowed: ['product', 'unit_amount', 'currency', 'recurring', 'metadata', 'nickname'],
      required: ['product', 'currency'],
      validators: {
        product: validateStripeId('prod_'),
        unit_amount: validatePositiveInteger,
        currency: validateCurrency,
      },
    },
    update: {
      allowed: ['metadata', 'nickname', 'active'],
      required: [],
      validators: {},
    },
  },
  invoice: {
    create: {
      allowed: ['customer', 'description', 'metadata', 'auto_advance', 'collection_method'],
      required: ['customer'],
      validators: {
        customer: validateStripeId('cus_'),
      },
    },
    update: {
      allowed: ['description', 'metadata', 'auto_advance'],
      required: [],
      validators: {},
    },
  },
  coupon: {
    create: {
      allowed: ['percent_off', 'amount_off', 'currency', 'duration', 'duration_in_months', 'name', 'metadata'],
      required: ['duration'],
      validators: {
        percent_off: validatePercentage,
        amount_off: validatePositiveInteger,
      },
    },
    update: {
      allowed: ['name', 'metadata'],
      required: [],
      validators: {},
    },
  },
  refund: {
    create: {
      allowed: ['payment_intent', 'charge', 'amount', 'reason', 'metadata'],
      required: [],  // Either payment_intent or charge required
      validators: {
        payment_intent: validateStripeId('pi_'),
        charge: validateStripeId('ch_'),
        amount: validatePositiveInteger,
      },
    },
  },
  payment_link: {
    create: {
      allowed: ['line_items', 'metadata', 'after_completion'],
      required: ['line_items'],
      validators: {},
    },
    update: {
      allowed: ['active', 'metadata'],
      required: [],
      validators: {},
    },
  },
};

interface EntitySchema {
  create?: OperationSchema;
  update?: OperationSchema;
}

interface OperationSchema {
  allowed: string[];
  required: string[];
  validators: Record<string, (value: unknown) => boolean>;
}

// Validator functions
function validateEmail(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validateMetadata(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  // Metadata must be key-value pairs with string values
  return Object.values(value).every(v => typeof v === 'string');
}

function validateStripeId(prefix: string): (value: unknown) => boolean {
  return (value: unknown) => {
    if (typeof value !== 'string') return false;
    return value.startsWith(prefix);
  };
}

function validatePositiveInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function validateCurrency(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return /^[a-z]{3}$/.test(value.toLowerCase());
}

function validateNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function validatePercentage(value: unknown): boolean {
  return typeof value === 'number' && value > 0 && value <= 100;
}

function validateSubscriptionItems(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every(item =>
    typeof item === 'object' &&
    item !== null &&
    ('price' in item || 'price_data' in item)
  );
}

function validateImageUrls(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.every(url => typeof url === 'string' && url.startsWith('https://'));
}

// Main validation function
export function validateStripeInput(
  entityType: string,
  operation: 'create' | 'update',
  data: Record<string, unknown>
): void {
  const schema = ENTITY_SCHEMAS[entityType];

  if (!schema) {
    throw new MCPError(
      MCPErrorCode.INVALID_ENTITY_TYPE,
      `Unsupported entity type: ${entityType}`
    );
  }

  const opSchema = schema[operation];
  if (!opSchema) {
    throw new MCPError(
      MCPErrorCode.INVALID_INPUT,
      `Operation ${operation} not supported for ${entityType}`
    );
  }

  // Check required fields
  for (const field of opSchema.required) {
    if (!(field in data) || data[field] === undefined || data[field] === null) {
      throw new MCPError(
        MCPErrorCode.INVALID_INPUT,
        `Missing required field: ${field}`,
        undefined,
        { entityType, operation, field }
      );
    }
  }

  // Check for disallowed fields
  for (const field of Object.keys(data)) {
    if (!opSchema.allowed.includes(field)) {
      throw new MCPError(
        MCPErrorCode.INVALID_INPUT,
        `Field not allowed: ${field}`,
        undefined,
        { entityType, operation, field, allowedFields: opSchema.allowed }
      );
    }
  }

  // Run validators
  for (const [field, validator] of Object.entries(opSchema.validators)) {
    if (field in data && !validator(data[field])) {
      throw new MCPError(
        MCPErrorCode.INVALID_INPUT,
        `Invalid value for field: ${field}`,
        undefined,
        { entityType, operation, field }
      );
    }
  }
}

// Validate Stripe ID format
export function validateStripeEntityId(entityType: string, entityId: string): void {
  const prefixes: Record<string, string> = {
    customer: 'cus_',
    subscription: 'sub_',
    invoice: 'in_',
    payment_intent: 'pi_',
    product: 'prod_',
    price: 'price_',
    payment_link: 'plink_',
    coupon: '', // Coupons can have custom IDs
    refund: 're_',
  };

  const prefix = prefixes[entityType];
  if (prefix === undefined) {
    throw new MCPError(
      MCPErrorCode.INVALID_ENTITY_TYPE,
      `Unknown entity type: ${entityType}`
    );
  }

  if (prefix && !entityId.startsWith(prefix)) {
    throw new MCPError(
      MCPErrorCode.INVALID_INPUT,
      `Invalid ${entityType} ID format: expected prefix ${prefix}`,
      undefined,
      { entityType, entityId }
    );
  }
}
