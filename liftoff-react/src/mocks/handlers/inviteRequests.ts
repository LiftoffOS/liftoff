import { http, HttpResponse } from 'msw'

export const inviteRequestsHandlers = [
  http.post('*/api/invite-requests', async () => {
    // Simulate slight network delay
    await new Promise(resolve => setTimeout(resolve, 500))
    return HttpResponse.json({ success: true })
  }),
]
