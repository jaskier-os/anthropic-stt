import Joi from 'joi';

const schema = Joi.object({
  port: Joi.number().integer().min(1).max(65535).default(10016),
  apiKey: Joi.string().required(),
}).unknown(false);

const { value, error } = schema.validate({
  port: process.env.PORT ? Number(process.env.PORT) : undefined,
  apiKey: process.env.API_KEY,
}, { stripUnknown: true });

if (error) {
  console.error('[config] Validation error:', error.message);
  process.exit(1);
}

const config = Object.freeze(value);
export default config;
