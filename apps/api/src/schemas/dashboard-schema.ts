import { z } from 'zod';

const pagination = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const storeListRequestSchema = z.object({
  query: pagination.extend({ tier: z.enum(['Large', 'Medium', 'Small']).optional() }).strict(),
});

export const failureListRequestSchema = z.object({ query: pagination });

export type StoreListQuery = z.infer<typeof storeListRequestSchema>['query'];
export type FailureListQuery = z.infer<typeof failureListRequestSchema>['query'];
