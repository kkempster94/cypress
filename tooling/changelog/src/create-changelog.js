const fs = require('fs-extra')
const path = require('path')

const { getCurrentReleaseData } = require('./semantic-commits/get-current-release-data')
const { getReleaseData } = require('./semantic-commits/get-binary-release-data')
const { getResolvedMessage } = require('./semantic-commits/get-resolve-message')

const { deleteChangesets, userFacingChanges } = require('./changeset')
const verifyChangesets = require('./verify-changesets')

const CHANGELOG = path.join(__dirname, '..', '..', '..', 'cli', 'CHANGELOG.md')

// whether or not the semantic type is a user-facing semantic-type
const hasUserFacingChange = (type) => Object.keys(userFacingChanges).includes(type)

const _handleErrors = (errors) => {
  console.error('There was one or more errors when comparing the Git commits data to the changesets...')
  errors.forEach((err) => {
    console.error(err)
    console.log()
  })
}

const getFormattedDate = () => {
  const date = new Date()
  let year = date.getFullYear()

  let month = (1 + date.getMonth()).toString()

  month = month.length > 1 ? month : `0${ month}`

  let day = date.getDate().toString()

  day = day.length > 1 ? day : `0${ day}`

  return `${month }/${ day }/${ year}`
}

const addResolveMessageToChangesets = ({ commits, changesets }) => {
  const errors = []

  // loop through each semantic commit and add the resolve message (i.e. Fixed in [#1](link_to_issue).)
  // to the changeset
  commits.forEach(({ commitMessage, semanticType, prNumber, associatedIssues, changesetFilenames }) => {
    if (!hasUserFacingChange(semanticType)) {
      return
    }

    const resolveMessage = getResolvedMessage(semanticType, prNumber, associatedIssues)

    // find each changeset file and add the resolveMessage details - most commits should only have one.
    changesetFilenames.forEach((file) => {
      // changesetFilename is uuid4.md, where as the git data returns the full file path <-- update this
      const match = changesets.find((c) => file.includes(c.changesetFilename))

      if (!match) {
        errors.push(`Missing changeset for ${commitMessage}. Manually add an entry before release Cypress`)

        return
      }

      console.log(`"${match.entry}"`)
      // verify the change entry ends with punctuation.
      if (match.entry.charAt(match.entry.length - 1) !== '.') {
        console.log('add period...')
        match.entry = `${match.entry}. ${resolveMessage}`
      } else {
        match.entry = `${match.entry} ${resolveMessage}`
      }

      if (match.type !== semanticType) {
        errors.push(`NEEDS ACTION: The type associated with ${match.changesetFilename} is ${match.type}, but this commit was checked into Git with type ${semanticType}. It is possible mis-match could cause a Cypress version discrepancy. Verify the bumped version is correct.`)
        // overriding to matched the committed type
        match.type = semanticType
      }
    })
  })

  return errors
}

/**
 * Creates Cypress changelog with the correct next version, the appropriate change sections and adds the associated issues / prs links to each entry.
 */
async function createChangelog ({ nextVersion, commits, changesets }) {
  const hasUserFacingCommits = commits.some(({ semanticType }) => hasUserFacingChange(semanticType))

  if (!hasUserFacingCommits) {
    console.log('Does not contain any user-facing changes that impacts the next Cypress release.')

    return []
  }

  console.log('Creating Changelog Content')
  let changelog = []

  changelog.push(`## ${nextVersion}`)
  changelog.push('')
  changelog.push(`_Released ${getFormattedDate()}_`) // TODO REAL DATE
  changelog.push('')

  const errors = addResolveMessageToChangesets({ commits, changesets })

  // loop through each changelog category and add any entries
  Object.entries(userFacingChanges).forEach(([semanticType, { section }]) => {
    const entriesForType = changesets.filter((c) => c.type === semanticType)

    if (!entriesForType.length) {
      console.log(`There are no ${semanticType} commits in this release.`)

      return
    }

    // add changelog section
    changelog.push(`${section}\n`)

    // add each changelog entry
    entriesForType.forEach(({ entry }) => changelog.push(`- ${entry}`))

    changelog.push('') // line break between sections
  })

  if (errors.length) {
    _handleErrors(errors)
  }

  if (changelog.length === 4) {
    throw new Error('entries were not added...')
  }

  console.log('changelog')

  return changelog
}

module.exports = async () => {
  const changesets = await verifyChangesets()

  if (!changesets.length) {
    console.log('No changes. Nothing to release.')
    process.exit(0)
  }

  const latestReleaseInfo = await getCurrentReleaseData()
  const releaseData = await getReleaseData(latestReleaseInfo)

  const dirPath = path.join(path.sep, 'tmp', 'releaseData')

  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath)
  }

  releaseData.changesets = changesets

  fs.writeFileSync(path.join(dirPath, 'releaseData.json'), JSON.stringify(releaseData, null, 2))

  console.log('')
  console.log('Release data saved to', path.join(dirPath, 'releaseData.json'))
  console.log('')

  const {
    nextVersion,
    changedFiles,
    commits,
  } = releaseData

  const changelogContentToAdd = await createChangelog({
    nextVersion,
    changedFiles,
    commits,
    changesets,
  })

  let currentChangelogContent = await fs.readFile(CHANGELOG, 'utf8')

  currentChangelogContent = currentChangelogContent.split('\n')

  // maintain comment on how to write the changelog
  const changelogComment = currentChangelogContent.shift()

  const updatedChangelog = [changelogComment].concat(changelogContentToAdd).concat(currentChangelogContent).join('\n')

  await fs.writeFile(CHANGELOG, updatedChangelog, 'utf8')

  console.log('Changelog has been updated! Deleting all changesets for next release.')
  await deleteChangesets()
}
