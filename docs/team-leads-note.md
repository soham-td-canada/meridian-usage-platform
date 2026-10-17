# Note for team leads: Meridian AI usage reporting

## What can I ask now?

You can ask about **your own group** only. Examples:

- "How much did my team use last month?"
- "Who were the top users this week?"
- "What capabilities are enabled for my group?"

Every usage question needs a time period, for example last 7 days, last 30 days, a week such as 2026-W36 or a month such as 2026-09. You get Claude and Gemini usage and cost, shown separately.

## What can I not see or change?

- Other groups' usage. Asking for another group returns a denial, not partial numbers.
- Capability changes outside your own group.
- In production, capability changes at all. Only platform admins can change them there. In staging you can change your own group's capabilities.

## Why?

Usage data is sensitive. Access is decided by the company directory (who you are, your role and your group) and by environment rules, never by what you type or ask. A denial is an intentional security control, not a fault. Platform admins have wider access so they can support every group.

## What if the usage connector is disabled?

If `usage-connector` is off for your group, usage and capability questions are refused with a "capability disabled" message. Nothing is shown. Anyone allowed to change your group's capabilities can still switch it back on. In production the connector is only on for IT Platform and Clinical Operations until another group asks for it.

## How do I ask for more access?

Contact IT Platform (a platform admin) with your group, the change you want (for example, "enable web-search for HR"), the environment, and a short business reason. Please do not ask someone else to run queries for you; their answers only cover their own access.
