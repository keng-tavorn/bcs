import { isAllowed } from '@/server/authz'
import { requestViewScope } from '../requests/view-scope'
import { registerFileSubjectPolicy } from './policies'

// FR-PLT-004 AC2: a file attached to a request (its attachments and the files of its quotations, FileLink subjectType
// "Request") downloads only for those who may view the request (request.view, §2.4). Registered when the file service
// loads, so no download path can miss it; a request that does not exist gives no access (deny by default, BR-AUTH-01).
registerFileSubjectPolicy('Request', async (tx, _ctx, principal, requestId) => {
  const scope = await requestViewScope(tx, requestId)
  return scope !== null && isAllowed(principal, 'request.view', scope)
})
