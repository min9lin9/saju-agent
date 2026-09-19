#!/usr/bin/env node
// saju.mjs — public CLI for the deterministic saju kernel.
//
//   node skills/saju/scripts/saju.mjs --input <request.json>
//   node skills/saju/scripts/saju.mjs --help
//
// Contract:
//   success   exit 0, exactly one serialized JSON result on stdout
//   failure   empty stdout; one JSON object {error:{code,path,message}} on
//             stderr; exit 2 for input/validation/computation errors (any
//             typed error carrying a string .code — InputError, TimeError,
//             CalendarError, NatalError, MajorCycleError, TransitError and
//             CLI usage errors), exit 1 for untyped internal failures
//             (missing dependency, I/O on rule tables, bugs)
//
// No network, no LLM fallback, no ambient clock. This file is the only
// entry point; calculate.mjs/serialize.mjs are importable libraries with no
// side effects.

import { readFileSync } from 'node:fs';
import { calculate } from './saju/calculate.mjs';
import { serializeResult } from './saju/serialize.mjs';

const USAGE = 'usage: node saju.mjs --input <request.json>';

class CliError extends Error {
  constructor(code, path, message) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.path = path;
  }
}

const parseArgs = (argv) => {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  let input = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input') {
      i += 1;
      if (i >= argv.length) {
        throw new CliError('MISSING_ARGUMENT', 'argv', '--input requires a file path');
      }
      input = argv[i];
    } else if (arg.startsWith('--input=')) {
      input = arg.slice('--input='.length);
    } else {
      throw new CliError('UNKNOWN_ARGUMENT', 'argv', `unknown argument: ${arg}`);
    }
  }
  if (input === null) {
    throw new CliError('MISSING_ARGUMENT', 'argv', USAGE);
  }
  return { help: false, input };
};

const emitError = (err) => {
  const typed = typeof err?.code === 'string';
  const body = {
    error: {
      code: typed ? err.code : 'INTERNAL_ERROR',
      path: typeof err?.path === 'string' ? err.path : null,
      message: typeof err?.message === 'string' ? err.message : String(err),
    },
  };
  process.stderr.write(`${JSON.stringify(body)}\n`);
  process.exitCode = typed ? 2 : 1;
};

const main = () => {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    emitError(err);
    return;
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  let rawText;
  try {
    rawText = readFileSync(args.input, 'utf8');
  } catch (err) {
    emitError(new CliError(
      'INPUT_FILE_UNREADABLE', 'input',
      `cannot read ${args.input}: ${err?.message ?? err}`,
    ));
    return;
  }

  let raw;
  try {
    raw = JSON.parse(rawText);
  } catch (err) {
    emitError(new CliError(
      'INVALID_JSON', 'input',
      `${args.input} is not a JSON document: ${err?.message ?? err}`,
    ));
    return;
  }

  try {
    process.stdout.write(serializeResult(calculate(raw)));
  } catch (err) {
    emitError(err);
  }
};

main();
