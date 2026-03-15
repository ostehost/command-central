/**
 * Activity Event Types — Data model for the Agent Activity Timeline
 *
 * Defines the core types for tracking agent activity across workspaces:
 * commits, task lifecycle events, grouped by time period.
 */

export type AgentRole = "developer" | "planner" | "reviewer" | "test";

export type ActivityAction =
	| {
			type: "commit";
			sha: string;
			message: string;
			filesChanged: number;
			insertions: number;
			deletions: number;
	  }
	| {
			type: "task-completed";
			taskId: string;
			exitCode: number;
			duration: string;
	  }
	| { type: "task-failed"; taskId: string; exitCode: number; error?: string }
	| { type: "task-started"; taskId: string; prompt: string };

export interface ActivityEvent {
	/** Unique ID (commit SHA, task ID, or generated) */
	id: string;
	/** When this happened */
	timestamp: Date;
	/** Which agent performed this action */
	agent: {
		name: string;
		role?: AgentRole;
		sessionId?: string;
	};
	/** What happened */
	action: ActivityAction;
	/** Which project/workspace */
	project: {
		name: string;
		dir: string;
	};
}

export type TimelinePeriod =
	| "lastHour"
	| "today"
	| "yesterday"
	| "last7days"
	| "older";

export interface TimelineGroup {
	period: TimelinePeriod;
	label: string;
	events: ActivityEvent[];
}
