import { logger as agentLogger } from './logger' // Assuming a base logger can be imported

import type { AgentAction, AgentState } from './AutofixAgent' // Adjust path as needed

// Define which actions are excluded from needing explicit handlers defined by the decorator
type ExcludedActions = 'idle'

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

// Sentinel for the end of an action sequence
export const AGENT_SEQUENCE_END = Symbol('AGENT_SEQUENCE_END')
export type NextActionOutcome = HandledAgentActions | typeof AGENT_SEQUENCE_END

export type ActionSequenceConfig = {
	// Key is a handled action that is part of a sequence,
	// value is the next action or the end sentinel.
	// Making it a partial map allows actions to not be part of a sequence if needed,
	// though for a linear workflow, all sequenced actions would be present.
	[ActionName in HandledAgentActions]?: NextActionOutcome
}

// Interface for what an instance of the decorated class should provide to handleActionSuccess
// This is a subset of AutofixAgent's properties and state structure.
interface AgentWithStateForSequence {
	state: Pick<AgentState, 'currentAction'>
	logger: typeof agentLogger // Assuming logger is available on 'this'
	// Add other methods/properties if handleActionSuccess needs them, e.g., setState if it were to modify state directly.
}

// The Decorator Function - renamed and signature updated
export function ConfigureAgentWorkflow<
	const TAllHandledActions extends ReadonlyArray<HandledAgentActions>,
	const TSequenceConfig extends ActionSequenceConfig,
	// TODO: Add more advanced type constraints to ensure TSequenceConfig keys/values are valid against TAllHandledActions
>(handledActions: TAllHandledActions, sequenceConfig: TSequenceConfig) {
	return function <
		TInstance extends AgentWithStateForSequence & {
			// This mapped type enforces that for each action name in the TAllHandledActions tuple,
			// the class instance must have a method with the derived handler name,
			// and that method must match the expected signature: () => Promise<void>.
			[K in TAllHandledActions[number] as ActionToHandlerName<K>]: () => Promise<void>
		},
		TargetClass extends new (...args: any[]) => TInstance,
	>(target: TargetClass): TargetClass | void {
		// Phase 2a: Decorator is primarily for type-checking handlers and being aware of the sequence.
		// It doesn't yet generate or modify runtime behavior based on sequenceConfig.

		// Example of a potential type-level check (conceptual, actual implementation might differ or be complex):
		// type IsValidSequence<Seq extends ActionSequenceConfig, Handled extends HandledAgentActions> = {
		//     [K in keyof Seq]: Seq[K] extends HandledAgentActions ? (Seq[K] extends Handled ? true : false) : true;
		// };
		// type Check = IsValidSequence<TSequenceConfig, TAllHandledActions[number]>;
		// This is a placeholder for where more advanced type validation of the sequence could go.

		// Add the handleActionSuccess method to the prototype of the decorated class
		target.prototype.handleActionSuccess = function (
			this: TInstance
		): NextActionOutcome | undefined {
			const currentAction = this.state.currentAction as HandledAgentActions // Cast needed as currentAction can be 'idle'

			if (!Object.prototype.hasOwnProperty.call(sequenceConfig, currentAction)) {
				// This successful action is not part of the defined sequence config,
				// or it's an action that shouldn't call this (e.g. 'idle' if it somehow reached here)
				this.logger.warn(
					`[AutofixAgent.handleActionSuccess] Action '${currentAction}' succeeded but is not in sequenceConfig or has no defined next step.`
				)
				return undefined // Or throw an error, or return a specific sentinel
			}

			const nextStep = sequenceConfig[currentAction]

			if (nextStep === AGENT_SEQUENCE_END) {
				this.logger.info(
					`[AutofixAgent.handleActionSuccess] Action '${currentAction}' succeeded, sequence ended.`
				)
				return AGENT_SEQUENCE_END
			} else if (nextStep) {
				// nextStep is a HandledAgentActions
				this.logger.info(
					`[AutofixAgent.handleActionSuccess] Action '${currentAction}' succeeded. Next action: '${nextStep}'.`
				)
				return nextStep
			}
			// Should not be reached if sequenceConfig is well-formed for all HandledAgentActions in a sequence
			this.logger.warn(
				`[AutofixAgent.handleActionSuccess] No next step defined for successful action '${currentAction}' in sequenceConfig.`
			)
			return undefined
		}

		return target // Standard decorator practice is to return the target or a new constructor
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
