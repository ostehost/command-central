/**
 * Type definitions for the Cron Jobs sidebar view.
 *
 * Matches the OpenClaw cron CLI JSON output schema.
 */

export interface CronJob {
	id: string;
	agentId?: string;
	name: string;
	description?: string;
	enabled: boolean;
	schedule: CronSchedule;
	sessionTarget: string;
	payload: CronPayload;
	delivery?: CronDelivery;
	state: CronState;
}

export type CronSchedule =
	| { kind: "cron"; expr: string; tz?: string; staggerMs?: number }
	| { kind: "every"; everyMs: number }
	| { kind: "at"; at: string };

export type CronPayload =
	| {
			kind: "agentTurn";
			message: string;
			model?: string;
			timeoutSeconds?: number;
	  }
	| { kind: "systemEvent"; text: string };

export interface CronDelivery {
	mode: "announce" | "webhook" | "none";
	channel?: string;
	to?: string;
	bestEffort?: boolean;
}

export interface CronState {
	lastRunAtMs?: number;
	lastStatus?: string;
	lastDurationMs?: number;
	lastError?: string;
	consecutiveErrors?: number;
	nextRunAtMs?: number;
}

export interface CronRun {
	id: string;
	jobId: string;
	startedAtMs: number;
	durationMs: number;
	status: string;
	error?: string;
	deliveryStatus?: string;
}

/** Discriminated union for tree elements */
export type CronTreeElement = CronSummaryNode | CronJobNode | CronDetailNode;

export interface CronSummaryNode {
	kind: "summary";
	activeCount: number;
	disabledCount: number;
}

export interface CronJobNode {
	kind: "job";
	job: CronJob;
}

export interface CronDetailNode {
	kind: "detail";
	jobId: string;
	label: string;
	value: string;
}
