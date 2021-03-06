import { bookmarkKeyPrefix } from 'src/bookmarks'
import index, { indexQueue } from '.'
import pipeline from './pipeline'
import {
    augmentIndexLookupDoc,
    initSingleLookup,
    initLookupByKeys,
    termRangeLookup,
    idbBatchToPromise,
} from './util'

// Used to decide whether or not to do a range lookup for terms (if # terms gt) or N single lookups
const termsSizeLimit = 3000
const lookupByKeys = initLookupByKeys()
const singleLookup = initSingleLookup()

/**
 * @typedef IndexTermValue
 * @type {Object}
 * @property {string} [latest] Latest visit/bookmark timestamp time for easy scoring.
 */

/**
 * @typedef IndexRequest
 * @type {Object}
 * @property {PageDoc} pageDoc
 * @property {VisitDoc[]} [visitDocs]
 * @property {BookmarkDoc[]} [bookmarkDocs]
 */

export const put = (key, val) => index.put(key, val)

/**
 * Adds a new page doc + any associated visit/bookmark docs to the index. This method
 * is *NOT* concurrency safe.
 * @param {IndexRequest} req A `pageDoc` (required) and optionally any associated `visitDocs` and `bookmarkDocs`.
 * @returns {Promise<void>} Promise resolving when indexing is complete, or rejecting for any index errors.
 */
export const addPage = req => performIndexing(pipeline(req))

/**
 * Adds a new page doc + any associated visit/bookmark docs to the index. This method
 * is concurrency safe as it uses a single queue instance to batch add requests.
 * @param {IndexRequest} req A `pageDoc` (required) and optionally any associated `visitDocs` and `bookmarkDocs`.
 * @returns {Promise<void>} Promise resolving when indexing is complete, or rejecting for any index errors.
 */
export const addPageConcurrent = req =>
    new Promise((resolve, reject) => {
        const indexDoc = pipeline(req).catch(reject)

        indexQueue.push(() =>
            performIndexing(indexDoc)
                .then(resolve)
                .catch(reject),
        )
    })

/**
 * @param {string} pageId ID/key of document to associate new bookmark entry with.
 * @param {number|string} [timestamp=Date.now()]
 * @throws {Error} Error thrown when `pageId` param does not correspond to existing document (or any other
 *  standard indexing-related Error encountered during updates).
 */
export const addBookmarkConcurrent = (pageId, timestamp = Date.now()) =>
    new Promise((resolve, reject) =>
        indexQueue.push(() =>
            addBookmark(pageId)
                .then(resolve)
                .catch(reject),
        ),
    )

/**
 * @param {string} pageId ID/key of document to associate new bookmark entry with.
 * @param {number|string} [timestamp=Date.now()]
 * @throws {Error} Error thrown when `pageId` param does not correspond to existing document (or any other
 *  standard indexing-related Error encountered during updates).
 */
async function addBookmark(pageId, timestamp = Date.now()) {
    const reverseIndexDoc = await singleLookup(pageId)

    if (reverseIndexDoc == null) {
        throw new Error(
            `No document exists in reverse page index for the supplied page ID: ${pageId}`,
        )
    }

    const bookmarkKey = `${bookmarkKeyPrefix}${timestamp}`

    // Add new entry to bookmarks index
    await index.put(bookmarkKey, pageId)

    // Add bookmarks index key to reverse page doc and update index entry
    reverseIndexDoc.bookmarks.add(bookmarkKey)
    await index.put(pageId, reverseIndexDoc)
}

/**
 * @param {IndexTermValue} currTermVal
 * @param {IndexLookupDoc} indexDoc
 * @returns {IndexTermValue} Updated `currTermVal` with new entry for `indexDoc`.
 */
function reduceTermValue(currTermVal, indexDoc) {
    if (currTermVal == null) {
        return new Map([[indexDoc.id, { latest: indexDoc.latest }]])
    }
    currTermVal.set(indexDoc.id, { latest: indexDoc.latest })
    return currTermVal
}

/**
 * @param {IndexLookupDoc} indexDoc
 * @returns {Promise<void>}
 */
const initIndexTerms = (termsField, termKey) => async indexDoc => {
    const indexBatch = index.batch()
    const termsSet = indexDoc[termsField]

    if (!termsSet.size) {
        return Promise.resolve()
    }

    const termValuesMap = await (termsSet.size > termsSizeLimit
        ? termRangeLookup(termKey, termsSet)
        : lookupByKeys([...termsSet]))

    for (const [term, currTermVal] of termValuesMap) {
        const termValue = reduceTermValue(currTermVal, indexDoc)
        indexBatch.put(term, termValue)
    }

    return idbBatchToPromise(indexBatch)
}

const indexTerms = initIndexTerms('terms', 'term/')
const indexUrlTerms = initIndexTerms('urlTerms', 'url/')
const indexTitleTerms = initIndexTerms('titleTerms', 'title/')

/**
 * @param {IndexLookupDoc} indexDoc
 * @returns {Promise<void>}
 */
async function indexMetaTimestamps(indexDoc) {
    const indexBatch = index.batch()
    const timeValuesMap = await lookupByKeys([
        ...indexDoc.bookmarks,
        ...indexDoc.visits,
    ])

    for (const [timestamp, existing] of timeValuesMap) {
        if (existing !== indexDoc.id) {
            indexBatch.put(timestamp, indexDoc.id)
        }
    }

    return idbBatchToPromise(indexBatch)
}

/**
 * @param {IndexLookupDoc} indexDoc
 * @returns {Promise<void>}
 */
async function indexPage(indexDoc) {
    const existingDoc = await singleLookup(indexDoc.id)

    // Ensure the terms and meta timestamps get merged with existing
    const newIndexDoc = !existingDoc
        ? indexDoc
        : {
              ...indexDoc,
              terms: new Set([...existingDoc.terms, ...indexDoc.terms]),
              titleTerms: new Set([
                  ...existingDoc.titleTerms,
                  ...indexDoc.titleTerms,
              ]),
              visits: new Set([...existingDoc.visits, ...indexDoc.visits]),
              bookmarks: new Set([
                  ...existingDoc.bookmarks,
                  ...indexDoc.bookmarks,
              ]),
          }

    const augIndexDoc = augmentIndexLookupDoc(newIndexDoc)
    await index.put(indexDoc.id, augIndexDoc)
    return augIndexDoc
}

/**
 * @param {IndexLookupDoc} indexDoc
 * @returns {Promise<void>}
 */
async function indexDomain(indexDoc) {
    const existingValue = await singleLookup(indexDoc.domain)

    return index.put(indexDoc.domain, reduceTermValue(existingValue, indexDoc))
}

/**
 * Runs all indexing logic on the page data concurrently for different types
 * as they all live on separate indexes.
 * @param {IndexLookupDoc} indexDoc
 * @returns {Promise<void>}
 */
async function performIndexing(indexDoc) {
    indexDoc = await indexDoc

    if (!indexDoc.terms.size) {
        return
    }

    try {
        // Run indexing of page
        console.time('indexing page')
        const augIndexDoc = await indexPage(indexDoc)
        await Promise.all([
            indexDomain(augIndexDoc),
            indexUrlTerms(augIndexDoc),
            indexTitleTerms(augIndexDoc),
            indexTerms(augIndexDoc),
            indexMetaTimestamps(augIndexDoc),
        ])
        console.timeEnd('indexing page')
        console.log('indexed', augIndexDoc)
    } catch (err) {
        console.error(err)
    }
}
