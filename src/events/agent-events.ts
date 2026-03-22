/**
 * Agent Events — Fired when agent status transitions occur
 *
 * Used by the Activity Timeline to display real-time agent lifecycle events.
 */

export interface AgentEvent {
	type: "agent-started" | "agent-completed" | "agent-failed";
	taskId: string;
	timestamp: Date;
	projectDir: string;
	elapsed?: string;
}
