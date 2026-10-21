export const REPO = "Yet-Another-Software-Suite/YAMS-Tuner"
export const REPO_URL = `https://github.com/${REPO}`

/** Set when the site is built into the SystemCore package (systemcore/build-ipk.sh), not the hosted site. */
export const ON_SYSTEMCORE = process.env.NEXT_PUBLIC_SYSTEMCORE === "1"
