const MAX_LOCAL_SHELL_ARGUMENTS = 64;
const MAX_LOCAL_SHELL_ARGUMENT_LENGTH = 4096;

/** Preserve blank rows while the controlled arguments field is being edited. */
export function parseLocalShellArgumentText(value: string): string[] {
  return value
    .split(/\r?\n/, MAX_LOCAL_SHELL_ARGUMENTS)
    .map((argument) => argument.slice(0, MAX_LOCAL_SHELL_ARGUMENT_LENGTH));
}

/** Empty editor rows describe layout, not arguments passed to the executable. */
export function localShellLaunchArguments(
  arguments_: readonly string[],
): string[] | undefined {
  const compact = arguments_.filter((argument) => argument.length > 0);
  return compact.length ? compact : undefined;
}
