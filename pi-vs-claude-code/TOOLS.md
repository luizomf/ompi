```ts
// Read the contents of a file. Supports text files and images. Output is truncated to 2000 lines or 50KB.
function read(
  path: string,         // Path to the file to read (relative or absolute)
  limit?: number,       // Maximum number of lines to read
  offset?: number       // Line number to start reading from (1-indexed)
): string;

// Execute a bash command in the current working directory. Returns stdout and stderr.
function bash(
  command: string,      // Bash command to execute
  timeout?: number      // Timeout in seconds (optional, no default timeout)
): string;

// Edit a file by replacing exact text. The oldText must match exactly (including whitespace).
function edit(
  path: string,         // Path to the file to edit (relative or absolute)
  oldText: string,      // Exact text to find and replace (must match exactly)
  newText: string       // New text to replace the old text with
): void;

// Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.
function write(
  path: string,         // Path to the file to write (relative or absolute)
  content: string       // Content to write to the file
): void;
```
