import { createRouter, createWebHashHistory } from 'vue-router'
import ClientView from '../views/ClientView.vue'
import ServerView from '../views/ServerView.vue'
import DictionaryView from '../views/DictionaryView.vue'
import LogView from '../views/LogView.vue'
import ProjectView from '../views/ProjectView.vue'

export default createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/client' },
    { path: '/client', component: ClientView },
    { path: '/server', component: ServerView },
    { path: '/dictionary', component: DictionaryView },
    { path: '/logs', component: LogView },
    { path: '/project', component: ProjectView }
  ]
})
