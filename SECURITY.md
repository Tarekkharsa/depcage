# Security

depcage is a security tool, so a way around it is a bug worth reporting.

## Reporting a problem

Please do not open a public issue for a way to escape the sandbox, read a hidden secret or reach
a blocked host. Use GitHub's private reporting instead: the **Security** tab of this repository,
then **Report a vulnerability**. You will get an answer within a week.

Ordinary bugs (a tool that does not work inside depcage, a confusing message) are welcome as
public issues.

## What depcage promises

For the command it runs, and everything that command starts:

- the files and folders in its secret list under your home folder cannot be read
- environment variables with secret-looking names are not passed on
- nothing outside the project folder (and, during installs, the package manager's download
  cache) can be written
- the internet is unreachable, except the package registry during installs and hosts you allow

## What it does not promise

The README lists the limits in full under "Limits". The important ones: the project folder
itself stays writable, download caches are writable during installs, localhost is reachable
outside installs on macOS, and secrets are hidden by a list, so a secret in an unusual place
is not covered.

depcage builds on [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime).
A weakness in that runtime, in `sandbox-exec` or in `bubblewrap` is also a weakness here.
