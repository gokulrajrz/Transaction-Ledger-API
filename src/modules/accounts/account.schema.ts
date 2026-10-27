import { z } from 'zod';
import { databaseText } from '../../common/validation.js';

export const createAccountSchema = z.strictObject({
  name: databaseText.trim().min(1).max(200),
});
