// Index of all event schemas (spec §15.3). Each import registers the events of one aggregate.
// Add one line per new file in src/server/events/schemas/ (one file per aggregate keeps parallel work apart).
import './schemas/auth'
import './schemas/file'
import './schemas/member'
import './schemas/organization'
