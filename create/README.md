# init-offense

Start a new app from [init-offense](https://github.com/2witstudios/init-offense)
with one command:

```sh
npx init-offense my-app
# or
bunx init-offense my-app
# or install it once, then run it anywhere
npm i -g init-offense
init-offense my-app
```

It checks for Git and Bun (offering to install Bun with the official
installer), downloads the template, and starts a guided setup that:

1. asks for your app's name and where to put it;
2. checks the tools it needs (Docker, the GitHub CLI, the PageSpace CLI) and
   offers to install the missing ones, showing each command first;
3. signs you in to GitHub and PageSpace (it opens the PageSpace sign-up page
   if you have no account yet);
4. creates the project, a private GitHub repository and the project's
   PageSpace drive, using a temporary PageSpace key it revokes afterwards;
5. starts the database and the app on free local ports and opens the sign-in
   page and your drive in the browser. Sign-in links print in the terminal
   (lines starting with `[dev-mail]`) until you add a Resend key.

Every flag after the directory goes to the guided setup:

| Flag                | Effect                                            |
| ------------------- | ------------------------------------------------- |
| `--name <slug>`     | short name for code and URLs, e.g. `widget-app`   |
| `--display <name>`  | the app's name as people see it                   |
| `--owner <owner>`   | GitHub account or organization for the repository |
| `--no-github`       | no GitHub repository                              |
| `--no-drive`        | no PageSpace drive                                |
| `--no-run`          | do not start the app at the end                   |
| `--yes`             | accept every default without asking               |
| `--dry-run`         | show every action without running any             |
| `--template <path>` | use a local checkout or another Git URL           |

`INIT_OFFENSE_TEMPLATE=<path or git url>` does the same as `--template`.

Requires Node 18 or newer (only to run this starter) and macOS or Linux
(on Windows, run it inside WSL).

## License

MIT
