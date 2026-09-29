# syntax=docker/dockerfile:1

# The k6 image already runs as the unprivileged `k6` user and has k6 on the
# entrypoint, so there is nothing to build and nothing to install. Pinning the
# minor version matters more here than elsewhere: executor semantics and the
# experimental Redis module have both changed between k6 minors.
FROM grafana/k6:0.53.0

COPY src /scripts

# --quiet drops the progress bar, which in a detached container is several
# hundred megabytes of carriage returns a day and tells nobody anything. The
# control scenario logs the state of the generator once a minute instead.
# --no-thresholds because there are none to check: this run never ends, so a
# threshold could only ever fail a test that has no result.
CMD ["run", "--quiet", "--no-thresholds", "/scripts/main.js"]
