/*
 *             discord-api-proxy
 *     Copyright (c) Synertry 2026.
 * Distributed under the Boost Software License, Version 1.0.
 *     (See accompanying file LICENSE or copy at
 *           https://www.boost.org/LICENSE_1_0.txt)
 */

/**
 * @module hear-me-out
 * Public API barrel file for the Hear Me Out feature module.
 *
 * Re-exports the Hono route handler and key domain types consumed by
 * the parent custom routes tree.
 */

export { hearMeOutRoutes } from './handler';
export type { HearMeOutResult, ClassifiedSubmission, UserTally, SubmissionEntry, UserEntity, SubmissionClassification } from './types';
