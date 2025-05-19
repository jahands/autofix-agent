import type { AgentAction } from './AutofixAgent' // Adjust path as needed

// Define which actions are excluded from needing explicit handlers defined by the decorator
type ExcludedActions = 'idle' | 'cycle_complete'

// Define the actions that are expected to have handlers
export type HandledAgentActions = Exclude<AgentAction, ExcludedActions>

// Utility type to convert snake_case or simple strings to PascalCase
// More robust PascalCase conversion might be needed for complex strings
type PascalCase<S extends string> = S extends `${infer P1}_${infer P2}`
	? `${Capitalize<Lowercase<P1>>}${PascalCase<Capitalize<Lowercase<P2>>>}`
	: Capitalize<S>

// Utility type to derive the expected handler method name from an action name
// e.g., 'initialize_container' -> 'handleInitializeContainer'
export type ActionToHandlerName<A extends HandledAgentActions> = `handle${PascalCase<A>}`

// Removed AGENT_SEQUENCE_END, NextActionOutcome, ActionSequenceConfig, AgentWithStateForSequence

// Simplified Decorator Function
export function EnsureAgentActions<
	// Renamed from setupAgentWorkflow, directly returns the decorator
	const THandledActions extends readonly HandledAgentActions[],
>(_actionsToHandle: THandledActions) {
	return function <
		Ctor extends new (...args: any[]) => {
			[K in THandledActions[number] as ActionToHandlerName<K>]: () => Promise<void>
		} & { [key: string]: any }, // Index signature for dynamic access, optional but can be kept for now
	>(value: Ctor, context: ClassDecoratorContext): Ctor | void {
		if (context.kind !== 'class') {
			throw new Error('EnsureAgentActions must be used as a class decorator.')
		}

		// This decorator now ONLY performs compile-time type checking for handler existence and signature.
		// It no longer injects any methods like handleActionSuccess.

		return value // Return the original constructor
	}
}

// --- Example of a more robust PascalCase utility for runtime (if needed for runtime checks) ---
// Not strictly required for the type-checking aspect if action names are simple snake_case.
/*
function pascalCase(str: string): string {
    return str
        .split(/[_-]/) // Split by underscore or hyphen
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join('');
}
*/
