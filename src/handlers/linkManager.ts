//
//  LinkManager.ts
//  p2a-services
//
//  Created by Murali Krishnan on 12/5/2024
//

import { inherits } from "util";

class LinkInfo {
    url: string; // url of the link
    by: string;  // who added the link - use the idForP2A
    ts: string;  // timestamp of when the link was added

    constructor(url: string, by: string, ts: string) {
        this.url = url;
        this.by = by;
        if (!ts || !ts.isWellFormed()) {
            this.ts = new Date().toISOString();
        } else {
            this.ts = ts;
        }
    }
}

// This class is used to manage the links.
// It is used to add, remove, check and modify links.
// ToDo: make this a LinkManager per user
// ToDo: persist the incoming links for future use
class LinkManager {
    private links: LinkInfo[]; // Assuming a simple string array for now
  
    constructor() {
      this.links = [];
    }

    _isValidLink(url: string): boolean {
        // Basic validation for now.
        // ToDo: Use robust URL validator to handle paywalls, file format, etc.
        // ToDo: Fetch URL and check for file content, etc.
        if (url.startsWith("http://") || url.startsWith("https://")) {
            return true;
        }
        return false;
    }

    _findLink(url: string, by: string): int {
//        return this.links.findIndex(link => link.url == url && link.by == by ) || -1;
        var returnIndex = -1;
        this.links.forEach((link, index) => {

            if (link.url == url && link.by == by) {
                returnIndex = index;
                return; // break from the inner function
            }
        });
        return returnIndex;
    }

    checkLink(url: string, by: string): boolean {

        return this._isValidLink(url);
    }
  
    getLinks(): LinkInfo[] {
        return this.links;
    }
    
    addLink(url: string, by: string, ts: string): boolean {

        if (this._isValidLink(url)) {
        this.links.push(new LinkInfo(url, by, ts));
        return true;
      }
      return false;
    }
  
    removeLink(url: string, by: string): boolean {
      const index = this._findLink(url, by)

      if (index > -1) {
        this.links.splice(index, 1);
        return true;
      }
      return false;
    }
  
    modifyLink(oldUrl: string, newUrl: string, by: string): boolean {
      const index = this._findLink(oldUrl, by)
      if (index > -1) {
        this.links[index] = new LinkInfo(newUrl, this.links[index].ts, this.links[index].by);
        return true;
      }
      return false;
    }
  }

  import { FastifyRequest, FastifyReply } from "fastify";

  let HTTP_STATUS_OK = 200;
  let HTTP_STATUS_CREATED = 201;
  let HTTP_STATUS_BAD_REQUEST = 400; 
  let HTTP_STATUS_NOT_FOUND = 404;
  
  export class LinkManagerHandlers {
    private linkManager: LinkManager;
  
    constructor() {
      this.linkManager = new LinkManager(); 
    }

    public async checkLinkHandler(request: FastifyRequest, reply: FastifyReply) {

        const { url, id } = request.query as { url: string, id: string };
          if (this.linkManager.checkLink(url, id)) {
          reply.code(HTTP_STATUS_OK)
              .send({ message: 'Link is valid' });
        } else {
          reply.code(HTTP_STATUS_NOT_FOUND)
              .send({ error: 'Invalid URL provided' });
        }
    }
    public async getLinksHandler(request: FastifyRequest, reply: FastifyReply) {
        reply.code(HTTP_STATUS_OK)
        .send( this.linkManager.getLinks());
    }
  
    public async addLinkHandler(request: FastifyRequest, reply: FastifyReply) {

      const { url, id, ts } = request.query as { url: string, id: string, ts: string };
        if (this.linkManager.addLink(url, id, ts)) {
        reply.code(HTTP_STATUS_CREATED)
            .send({ message: 'Link added' });
      } else {
        reply.code(HTTP_STATUS_BAD_REQUEST)
            .send({ error: 'Invalid URL provided for adding link' });
      }
    }

    public async removeLinkHandler(request: FastifyRequest, reply: FastifyReply) {
        const { url, id } = request.query as { url: string, id: string };
          if (this.linkManager.removeLink(url, id)) {
          reply.code(HTTP_STATUS_OK)
              .send({ message: 'Link removed' });
        } else {
          reply.code(HTTP_STATUS_NOT_FOUND)
              .send({ error: 'Link is not found' });
        }
      }
        
      public async modifyLinkHandler(request: FastifyRequest, reply: FastifyReply) {
        const { oldUrl, newUrl, id } = request.query as { oldUrl: string, newUrl: string, id: string };
          if (this.linkManager.modifyLink( oldUrl, newUrl, id)) {
          reply.code(HTTP_STATUS_OK)
              .send({ message: 'Link is modified' });
        } else {
          reply.code(HTTP_STATUS_NOT_FOUND)
              .send({ error: 'Link is not found' });
        }
      }
  }

// Let us set up the routes for use in the server
import type { FastifyInstance } from 'fastify';
import { int } from "aws-sdk/clients/datapipeline";

// 'api' will be LinkManagerHandlers instance
export const linkRoutes = async (fastify: FastifyInstance, api: any) => { 
    fastify.get('/links/check', api.checkLinkHandler.bind(api));
    fastify.get('/links/all', api.getLinksHandler.bind(api));
    // fastify.get('/links/:url', api.checkLinkHandler.bind(api));
    fastify.post('/links', api.addLinkHandler.bind(api));
    fastify.delete('/links', api.removeLinkHandler.bind(api));
    fastify.put('/links', api.modifyLinkHandler.bind(api));
};
