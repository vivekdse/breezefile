# Reaction to inspirations

<br />

## Next steps

I want you to do the following things:

* Take a look at my comments below. Draw the best features from different inspirations
* Look at all of my typebuild tasks that are going on.  It can get overwhelming.  This is what we want to simplify.  To do that, I want you to come up with some ideas on using parent-child relationships so that we can show some kind of aggregate stats about what's going on in a project, how many tasks are working, etc, etc, and how many need attention, and allow people to drill into any specific thing.
* I think we need some kind of a setup where we have a hierarchy of projects as well. Basically the way I'm thinking about it is that let's say that I have insurance authorization and I have a set of instructions about it but I may have specific instructions on HMO patients. I need that ability to cascade instructions based on the task. It could be either hierarchy or it could be some way of linking tasks or rather tagging specific instructions relevant for categories of tasks. So we need to come up with an abstraction for that as well.
* The system we have built this on is a keyboard friendly system that uses verbs as an abstraction. I want you to take a look at Breeze file and how it is built so that the next set of inspirations built on our keyboard friendly verb based approach.

## Reactions

Here are my reactions to different inspirations:

### file:///home/vivek/git\_repos/breezefile/design-assets/inspirations/variation-2-command-bar.html

* For a given project I like the simplicity of how tasks are shown but I don't like the way that the icons don't line up properly. They are not aligned fairly well for visual ease.
* I really like the idea of proposed tasks with a simple card clicking which will open a detailed task, a proposed task.
* The approach to instructions is also neat. Even though it's pretty small, I like the fact that we have a number of these ideas and then we say teach as a button with a new idea that's there.
* Every task must be openable by clicking in which we can see the details of what we've specified such as nodes, when it's supposed to run etc. And we should also have some kind of a trace for the task that is either running or has run and we should have the ability to stop a task.  Agent inbox handles the opening part.  
* I do not like the current approach we have to creating or viewing projects because it's a dropdown at the top. I don't have the ability to see all my projects and how many tasks they have within, which would be quite useful.
* It may be useful to help the user understand task dependencies and the parent-child relationships that we have set up. Currently, we don't have that representation for tasks.

<br />

### Mission control

Too busy.  I don't like this. 

<br />

### Agent inbox

* I like the fact that we show clean indicators for whether tasks are blocked or in progress, etc.
* I like the idea of steerability but the way things work right now is that we go into an agent thread. So if a task is in progress or if it's waiting on me, we should basically have a way for people to get into the thread.

### Living timeline

* I like the idea of showing some kind of live action on what is going on and the way in which we reorder things etc. We should take a look at the different statuses that we have for typebuild tasks such as claimed etc etc and perhaps use that in order to create the living timeline.

<br />

### Split monitor

* I do not like the email inbox kind of approach where we show the list of tasks and what's happening within a task on the right side only because it makes it a little busy.
* For current and the past tasks, I like the notion of some kind of a live session that shows the terminal and what's going on. What we could quite easily do is to basically have a place in the task for in-progress tasks or ones that are completed so that people can see the session and what happened at the session.

<br />

## Decision

* **I like the Project Atlas approach** (`variation-10-project-atlas.html`) — the projects-overview → drill-into-hierarchy zoom model. This is the direction to build on.

<br />

<br />

