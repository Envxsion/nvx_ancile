/**
 * Types the flows contract exports only as schemas, inferred once here.
 */
import type {
  FlowEstimate,
  FlowVersion as FlowVersionSchema,
  ValidateFlowResponse as ValidateSchema,
} from '@nvx/contracts';
import type { z } from 'zod';

export type FlowVersion = z.infer<typeof FlowVersionSchema>;
export type ValidateFlowResponse = z.infer<typeof ValidateSchema>;
export type FlowEstimateT = z.infer<typeof FlowEstimate>;
