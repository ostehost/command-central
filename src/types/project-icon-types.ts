/**
 * Type definitions for Project Icon feature
 */

export interface ProjectIconConfig {
	/** The icon to display (emoji, codicon, or text) */
	icon?: string;
	/** Tooltip text when hovering over the icon */
	tooltip?: string;
	/** Whether to show icon in status bar */
	showInStatusBar?: boolean;
	/** Priority for status bar positioning (higher = further left) */
	priority?: number;
}
