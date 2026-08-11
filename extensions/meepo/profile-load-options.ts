/** Process-wide profile load options from Meepo config (set by MeepoRuntime.start). */

export interface ActiveProfileLoadOptions {
	dirs: string[];
	extraTools: string[];
	allowUnknownTools: boolean;
}

let active: ActiveProfileLoadOptions = {
	dirs: [],
	extraTools: [],
	allowUnknownTools: false,
};

export function setActiveProfileLoadOptions(options: {
	dirs?: string[];
	extraTools?: string[];
	allowUnknownTools?: boolean;
}): void {
	active = {
		dirs: options.dirs ? [...options.dirs] : [],
		extraTools: options.extraTools ? [...options.extraTools] : [],
		allowUnknownTools: options.allowUnknownTools ?? false,
	};
}

export function getActiveProfileLoadOptions(): ActiveProfileLoadOptions {
	return {
		dirs: [...active.dirs],
		extraTools: [...active.extraTools],
		allowUnknownTools: active.allowUnknownTools,
	};
}
