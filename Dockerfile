# First, specify the base Docker image. You can read more about
# the available images at https://docs.apify.com/sdk/js/docs/guides/docker-images
# This one comes with Playwright + Chromium preinstalled, needed for PlaywrightCrawler.
FROM apify/actor-node-playwright-chrome:24

# Second, copy just package.json and package-lock.json since it should be
# the only file that affects "npm install" in the next step, to speed up the build
COPY --chown=myuser:myuser package*.json ./

# Install NPM packages, skip optional and development dependencies to
# keep the image small. Avoid logging too much and print the dependency
# tree for debugging
RUN npm --quiet set progress=false \
 && npm install --omit=dev --omit=optional \
 && echo "Installed NPM packages:" \
 && (npm list --omit=dev --all || true) \
 && echo "Node.js version:" \
 && node --version \
 && echo "NPM version:" \
 && npm --version \
 && rm -r ~/.npm

# Next, copy the remaining files and directories with the source code.
# Since we do this after NPM install, quick build will be really fast
# for most source file changes.
COPY --chown=myuser:myuser . ./

# Run the actor.
CMD ["node", "main.js"]
