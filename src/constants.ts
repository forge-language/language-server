export const KEYWORDS = [
  'process', 'coroutine', 'supervisor', 'spawn', 'send', 'recv', 'yield',
  'on', 'receive', 'let', 'mut', 'own', 'move', 'await',
  'fn', 'return', 'if', 'else', 'while', 'for', 'break', 'continue',
  'struct', 'enum', 'native', 'extern', 'import', 'library', 'export',
  'true', 'false', 'match', 'const', 'restart',
] as const;

export const TYPES = ['int', 'float', 'bool', 'string', 'void', 'ptr'] as const;

export const STDLIB_MODULES: Record<string, string[]> = {
  io: [
    'print', 'print_int', 'print_str', 'println', 'eprint', 'eprint_int', 'eprintln',
    'flush', 'flush_err', 'read_line', 'read_char', 'read_stdin', 'prompt',
    'write_fd', 'read_fd', 'stdin_fd', 'stdout_fd', 'stderr_fd',
  ],
  strings: [
    'str_len', 'str_concat', 'str_eq', 'str_sub', 'str_contains', 'str_trim',
    'str_char_at', 'str_append', 'str_append_str', 'str_from_int', 'str_reset_arena',
  ],
  math: ['abs_i', 'abs_f', 'min_i', 'max_i', 'clamp_i', 'pow_i'],
  time: ['time_now_ms', 'sleep_ms'],
  fs: [
    'fs_read', 'fs_write', 'fs_append', 'fs_exists', 'fs_remove', 'fs_size',
    'fs_is_file', 'fs_is_dir', 'fs_mkdir', 'fs_rename', 'fs_copy', 'fs_list_dir',
  ],
  os: ['os_exit', 'os_getenv', 'os_argc', 'os_argv'],
  tcp: ['tcp_listen', 'tcp_accept', 'tcp_connect', 'tcp_send', 'tcp_recv', 'tcp_close', 'net_init'],
  udp: ['udp_bind', 'udp_send', 'udp_recv', 'udp_peer', 'udp_close'],
  http: [
    'http_get', 'http_post', 'http_listen', 'http_accept', 'http_req_method',
    'http_req_path', 'http_req_body', 'http_respond', 'http_close', 'http_server_close',
    'http_prepare', 'http_serve_prepared', 'http_serve_forever', 'http_serve_ok', 'http_serve_mt',
  ],
  event: ['event_poll', 'event_add_read'],
  json: ['json_get_string', 'json_get_int', 'json_stringify_str', 'json_stringify_int'],
};

export const SNIPPETS: Record<string, string> = {
  process: 'process ${1:name} {\n\t$0\n}',
  coroutine: 'coroutine ${1:name}($2) {\n\t$0\n}',
  fn: 'fn ${1:name}($2): ${3:int} {\n\t$0\n}',
  for: 'for (let ${1:i}: int = 0; ${1:i} < ${2:n}; ${1:i} += 1) {\n\t$0\n}',
  while: 'while (${1:cond}) {\n\t$0\n}',
  if: 'if (${1:cond}) {\n\t$0\n}',
  match: 'match ${1:expr} {\n\t${2:pat} => { $0 }\n\t_ => {}\n}',
  import: 'import ${1:module};',
  spawn: 'spawn ${1:coro}($2);',
};

export const HOVER_DOCS: Record<string, string> = {
  process: 'Lightweight process — unit of state ownership and isolation.',
  coroutine: 'Coroutine inside a process; use spawn and yield.',
  supervisor: 'Fault-tolerance wrapper with restart policies.',
  spawn: 'Start a coroutine inside the current process.',
  yield: 'Suspend the current coroutine until resumed.',
  await: 'Yield until a file descriptor is readable (epoll/kqueue).',
  own: 'Declare heap-owned string with move semantics.',
  move: 'Transfer ownership of a value.',
  match: 'Pattern match on integers with wildcard `_`.',
  const: 'Compile-time constant folded by the optimizer.',
  '|>': 'Pipe value as first argument: `x |> f()` → `f(x)`.',
};
