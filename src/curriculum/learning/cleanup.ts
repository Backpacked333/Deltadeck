import { openOutbox, type DurableEvent } from '../../net/syncOutbox'
import type { SyncScope } from '../../net/syncRevision'

/** Only a reconciled server deletion fence authorizes removing private local events. */
export async function cleanupDeletedEvidence(
  scope: SyncScope,
  generations: { learning: number; practice: number },
  current: () => boolean,
  factory?: IDBFactory,
) {
  const db = await openOutbox(factory)
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['events', 'jobs', 'scopes'], 'readwrite')
      tx.oncomplete = () => resolve()
      tx.onabort = tx.onerror = () =>
        reject(tx.error ?? new Error('Deletion cleanup aborted'))
      const meta = tx.objectStore('scopes').get(scope.accountId)
      meta.onsuccess = () => {
        if (!current() || (meta.result && meta.result.epoch > scope.epoch)) {
          tx.abort()
          return
        }
        const events = tx.objectStore('events'),
          request = events.getAll()
        request.onsuccess = () => {
          if (!current()) {
            tx.abort()
            return
          }
          const rows = (request.result as DurableEvent[]).filter(
            (e) => e.accountId === scope.accountId,
          )
          const parsed = rows.map((e) => {
            try {
              return { e, p: JSON.parse(e.serialized) }
            } catch {
              return { e, p: null }
            }
          })
          const remove = new Set(
            parsed
              .filter(
                ({ e, p }) =>
                  e.deletionGeneration < generations.learning ||
                  (p?.kind === 'submission' &&
                    p.source === 'practice' &&
                    p.practice?.practiceGeneration < generations.practice) ||
                  (p?.kind === 'recommendation' &&
                    p.practiceGeneration < generations.practice),
              )
              .map(({ e }) => e.id),
          )
          for (const { e, p } of parsed)
            if (
              p &&
              (remove.has(p.submissionId) || remove.has(p.recommendationId))
            )
              remove.add(e.id)
          for (const id of remove) {
            events.delete([scope.accountId, id])
            tx.objectStore('jobs').delete([scope.accountId, id])
          }
        }
      }
    })
  } finally {
    db.close()
  }
}
